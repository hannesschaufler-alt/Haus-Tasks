// Bidirektionaler Sync App <-> Google-Kalender „Haus-Tasks“.
// Aufruf per CLI (`node sync.js`, z. B. durch die Windows-Aufgabenplanung) oder aus dem Server.
//
// Ablauf: erst Änderungen aus Google holen (pull), dann lokale Änderungen senden (push).
// Konflikte entscheidet der jüngere Zeitstempel. Erledigt = Titelpräfix „✓ “ + graue Farbe.
const fs = require('node:fs');
const { db, getMeta, setMeta } = require('./db');
const { DONE_COLOR, DONE_PREFIX, LOCK_FILE } = require('./config');
const { addDays } = require('./public/recurrence');
const tasks = require('./tasks');

const DONE_RE = /^✓\s*/;

function httpStatus(e) {
  return e.status ?? e.response?.status ?? (Number.isInteger(Number(e.code)) ? Number(e.code) : undefined);
}
const isGone = (e) => [404, 410].includes(httpStatus(e));

function eventBody(t) {
  return {
    summary: (t.done ? DONE_PREFIX : '') + t.title,
    start: { date: t.due_date },
    end: { date: addDays(t.due_date, 1) }, // Ende ganztägiger Events ist exklusiv
    colorId: t.done ? DONE_COLOR : t.color,
    transparency: 'transparent', // blockiert die Verfügbarkeit nicht
  };
}

const rowByEvent = (id) => db.prepare('SELECT * FROM tasks WHERE google_event_id = ?').get(id);

async function pull(remote) {
  const token = getMeta('sync_token');
  let res;
  try {
    res = await remote.listChanges(token);
  } catch (e) {
    if (!token || !isGone(e)) throw e;
    setMeta('sync_token', null); // Token abgelaufen: komplett neu abgleichen
    res = await remote.listChanges(null);
  }
  const full = !res.incremental;
  const seen = new Set();
  let changed = 0;

  for (const ev of res.events) {
    if (ev.status !== 'cancelled') seen.add(ev.id);
    if (applyRemoteEvent(ev)) changed++;
  }

  if (full) {
    // Was lokal ein Google-Event hat, dort aber nicht mehr vorkommt, wurde in Google gelöscht.
    const linked = db.prepare('SELECT * FROM tasks WHERE google_event_id IS NOT NULL AND deleted = 0').all();
    for (const row of linked) {
      if (seen.has(row.google_event_id)) continue;
      if (row.dirty) {
        db.prepare('UPDATE tasks SET google_event_id=NULL, google_updated=NULL WHERE id=?').run(row.id); // lokale Änderung gewinnt
      } else {
        db.prepare('DELETE FROM tasks WHERE id=?').run(row.id);
        changed++;
      }
    }
  }
  if (res.nextSyncToken) setMeta('sync_token', res.nextSyncToken);
  return changed;
}

// Gibt true zurück, wenn lokal etwas geändert wurde.
function applyRemoteEvent(ev) {
  const row = rowByEvent(ev.id);

  if (ev.status === 'cancelled') {
    if (!row) return false;
    db.prepare('DELETE FROM tasks WHERE id=?').run(row.id);
    return true;
  }
  if (!ev.start?.date || ev.recurrence) return false; // nur einzelne ganztägige Events

  const summary = ev.summary || '(ohne Titel)';
  const remoteDone = DONE_RE.test(summary);
  const title = summary.replace(DONE_RE, '') || '(ohne Titel)';

  if (!row) {
    const ts = ev.updated || tasks.now();
    const color = ev.colorId && !(remoteDone && ev.colorId === DONE_COLOR) ? ev.colorId : '9';
    db.prepare(
      `INSERT INTO tasks (title, due_date, priority, color, done, done_at, google_event_id, google_updated, dirty, created_at, updated_at)
       VALUES (?, ?, 'mittel', ?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(title, ev.start.date, color, remoteDone ? 1 : 0, remoteDone ? ts : null, ev.id, ev.updated || null, ts, ts);
    return true;
  }
  if (row.deleted) return false; // Löschung steht noch aus
  if (ev.updated && ev.updated === row.google_updated) return false; // Echo unserer eigenen Änderung
  if (row.dirty && ev.updated && row.updated_at > ev.updated) return false; // lokal jünger, wird gepusht

  let color = row.color;
  let needsPush = false;
  if (!remoteDone && ev.colorId) {
    if (ev.colorId === DONE_COLOR && row.done) needsPush = true; // Graphit war nur die Erledigt-Markierung: ursprüngliche Farbe wiederherstellen
    else color = ev.colorId;
  }
  db.prepare(
    'UPDATE tasks SET title=?, due_date=?, color=?, google_updated=?, updated_at=?, dirty=? WHERE id=?'
  ).run(title, ev.start.date, color, ev.updated || null, ev.updated || tasks.now(), needsPush ? 1 : 0, row.id);

  if (remoteDone !== !!row.done) tasks.setDone(row.id, remoteDone); // erzeugt bei Serien den Folgetermin, markiert für Push
  return true;
}

async function push(remote) {
  const errors = [];
  let pushed = 0;
  const rows = db.prepare('SELECT * FROM tasks WHERE dirty = 1').all();

  for (const row of rows) {
    try {
      if (row.deleted) {
        if (row.google_event_id) await remote.remove(row.google_event_id).catch((e) => { if (!isGone(e)) throw e; });
        db.prepare('DELETE FROM tasks WHERE id=?').run(row.id);
        pushed++;
        continue;
      }
      const t = tasks.fromRow(row);
      if (!t.due_date) {
        // Ohne Datum gehört der Task nur in die App.
        if (row.google_event_id) await remote.remove(row.google_event_id).catch((e) => { if (!isGone(e)) throw e; });
        db.prepare('UPDATE tasks SET google_event_id=NULL, google_updated=NULL, dirty=0 WHERE id=? AND updated_at=?').run(row.id, row.updated_at);
        continue;
      }
      let ev;
      if (row.google_event_id) {
        try {
          ev = await remote.patch(row.google_event_id, eventBody(t));
        } catch (e) {
          if (!isGone(e)) throw e;
          ev = await remote.insert(eventBody(t)); // Event fehlt in Google: neu anlegen
        }
      } else {
        ev = await remote.insert(eventBody(t));
      }
      db.prepare('UPDATE tasks SET google_event_id=?, google_updated=? WHERE id=?').run(ev.id, ev.updated, row.id);
      db.prepare('UPDATE tasks SET dirty=0 WHERE id=? AND updated_at=?').run(row.id, row.updated_at); // nur, wenn zwischenzeitlich nichts geändert wurde
      pushed++;
    } catch (e) {
      errors.push(`Task ${row.id}: ${e.message}`);
    }
  }
  return { pushed, errors };
}

async function syncWith(remote) {
  const pulled = await pull(remote);
  const { pushed, errors } = await push(remote);
  return { pulled, pushed, errors };
}

// Eine Sperre gilt als verwaist, wenn ihr Prozess nicht mehr läuft oder sie älter als 5 Minuten ist.
function lockIsStale() {
  if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs > 5 * 60 * 1000) return true;
  const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8'));
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === 'ESRCH';
  }
}

// Verhindert parallele Syncs (Server + Aufgabenplanung).
function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE) && lockIsStale()) fs.unlinkSync(LOCK_FILE);
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
  } catch {
    return null;
  }
  return () => { try { fs.unlinkSync(LOCK_FILE); } catch { /* schon weg */ } };
}

async function googleRemote() {
  const { api, ensureCalendar } = require('./gcal');
  const cal = api();
  const calendarId = await ensureCalendar(cal);
  return {
    async listChanges(syncToken) {
      const events = [];
      let pageToken;
      let nextSyncToken;
      do {
        const res = await cal.events.list({
          calendarId,
          maxResults: 250,
          pageToken,
          ...(syncToken ? { syncToken } : {}),
        });
        events.push(...(res.data.items || []));
        pageToken = res.data.nextPageToken;
        nextSyncToken = res.data.nextSyncToken || nextSyncToken;
      } while (pageToken);
      return { events, nextSyncToken, incremental: !!syncToken };
    },
    insert: async (body) => (await cal.events.insert({ calendarId, requestBody: body })).data,
    patch: async (id, body) => (await cal.events.patch({ calendarId, eventId: id, requestBody: body })).data,
    remove: async (id) => { await cal.events.delete({ calendarId, eventId: id }); },
  };
}

// Vollständiger Sync mit Sperre und Statusvermerk. `remote` nur zum Testen überschreibbar.
async function runSync(remote) {
  const release = acquireLock();
  if (!release) return { skipped: true };
  try {
    const result = await syncWith(remote || (await googleRemote()));
    setMeta('last_sync', tasks.now());
    setMeta('last_error', result.errors.length ? result.errors.join('; ') : null);
    return result;
  } catch (e) {
    setMeta('last_error', e.message);
    throw e;
  } finally {
    release();
  }
}

module.exports = { runSync, syncWith, eventBody };

if (require.main === module) {
  runSync()
    .then((r) => {
      console.log(r.skipped ? 'Sync läuft bereits.' : `Sync fertig: ${r.pulled} aus Google übernommen, ${r.pushed} gesendet.`);
      if (r.errors?.length) { console.error(r.errors.join('\n')); process.exitCode = 1; }
    })
    .catch((e) => { console.error('Sync fehlgeschlagen:', e.message); process.exitCode = 1; });
}
