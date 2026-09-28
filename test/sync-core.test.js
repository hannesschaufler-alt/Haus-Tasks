const test = require('node:test');
const assert = require('node:assert');
const S = require('../public/sync-core');

// --- Fake-Kalender: gleiche Schnittstelle wie das echte Google-Calendar-REST-API ---
function fakeRemote() {
  const events = new Map();
  let version = 0;
  let last = 0;
  const stamp = () => new Date((last = Math.max(Date.now(), last + 1))).toISOString();
  const store = (ev) => { ev._v = ++version; events.set(ev.id, ev); return ev; };
  let n = 0;
  const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });
  // Die Konfiguration ist – wie beim echten Google-Kalender – ein ganz normaler Termin im selben
  // Kalender (erkennbar an appMarker), kein separater Speicherort. Nur so fällt z. B. auf, wenn dieser
  // Termin fälschlich auch als Task eingelesen würde.
  const findConfigEvent = () => [...events.values()].find((e) => e.status !== 'cancelled' && e.extendedProperties?.private?.appMarker === S.CONFIG_MARKER);
  return {
    events,
    async listChanges(token) {
      const incremental = !!token;
      const items = [...events.values()].filter((e) => (incremental ? e._v > Number(token) : e.status !== 'cancelled'));
      return { events: items.map((e) => ({ ...e })), nextSyncToken: String(version), incremental };
    },
    async get(id) {
      const ev = events.get(id);
      if (!ev || ev.status === 'cancelled') throw notFound();
      return { ...ev };
    },
    async insert(body) { return { ...store({ ...body, id: `ev${++n}`, updated: stamp() }) }; },
    async patch(id, body) {
      const cur = events.get(id);
      if (!cur || cur.status === 'cancelled') throw notFound();
      return { ...store({ ...cur, ...body, updated: stamp() }) };
    },
    async remove(id) { if (events.has(id)) store({ ...events.get(id), status: 'cancelled', updated: stamp() }); },
    async readConfig() {
      const ev = findConfigEvent();
      if (!ev) return null;
      const p = ev.extendedProperties.private;
      return { id: ev.id, updated: ev.updated, categories: JSON.parse(p.categories), locations: JSON.parse(p.locations) };
    },
    async writeConfig(id, cfg) {
      const body = {
        summary: '⚙️ Haus-Tasks Einstellungen (bitte nicht löschen oder bearbeiten)',
        start: { date: '1970-01-01' }, end: { date: '1970-01-02' },
        extendedProperties: { private: { appMarker: S.CONFIG_MARKER, categories: JSON.stringify(cfg.categories), locations: JSON.stringify(cfg.locations) } },
      };
      const ev = id ? store({ ...events.get(id), ...body, updated: stamp() }) : store({ ...body, id: `ev${++n}`, updated: stamp() });
      return { id: ev.id, updated: ev.updated };
    },
    // Testhilfen, die ein zweites, unabhängiges Gerät (oder Google selbst) nachbilden
    editDirect(id, fields) { store({ ...events.get(id), ...fields, updated: stamp() }); },
    active: () => [...events.values()].filter((e) => e.status !== 'cancelled'),
  };
}

// --- Fake-Speicher: ein Gerät (In-Memory statt IndexedDB) ---
function fakeStore() {
  let tasks = [];
  let outbox = [];
  let seq = 0;
  let meta = {};
  let config = null;
  return {
    async getRawTasks() { return tasks; },
    async saveRawTasks(t) { tasks = t; },
    async getMeta(k) { return meta[k] ?? null; },
    async setMeta(k, v) { meta[k] = v; },
    async getConfig() { return config; },
    async saveConfig(c) { config = c; },
    async getOutbox() { return outbox; },
    async removeOutboxEntry(s) { outbox = outbox.filter((e) => e.seq !== s); },
    // Testhilfe: legt lokal einen Task an und reiht die passende Warteschlangen-Operation ein,
    // genau wie es Offline.mutate() im Browser täte.
    async enqueue(op, taskId, patch, baseUpdatedAt) { outbox.push({ seq: ++seq, op, taskId, patch, baseUpdatedAt }); },
    tasksRef: () => tasks,
  };
}

const OfflineLogic = require('../public/offline-logic');
async function createLocal(store, input, categories = {}) {
  const raw = await store.getRawTasks();
  const { task, tasks } = OfflineLogic.createTask(raw, input, categories);
  await store.saveRawTasks(tasks);
  await store.enqueue('create', task.id, input);
  return task;
}
async function updateLocal(store, id, patch, categories = {}) {
  const raw = await store.getRawTasks();
  const before = raw.find((t) => t.id === id);
  const { task, tasks } = OfflineLogic.updateTask(raw, id, patch, categories);
  await store.saveRawTasks(tasks);
  await store.enqueue('update', id, patch, before.updated_at);
  return task;
}
async function doneLocal(store, id, done) {
  const raw = await store.getRawTasks();
  const before = raw.find((t) => t.id === id);
  const { task, tasks, created } = OfflineLogic.setDone(raw, id, done);
  await store.saveRawTasks(tasks);
  await store.enqueue('done', id, { done }, before.updated_at);
  // Ein Folgetermin einer Serie entsteht lokal und braucht einen eigenen „Anlegen“-Auftrag –
  // push() weiß nichts von Serien, es sendet nur, was in der Warteschlange steht.
  if (created) await store.enqueue('create', created.id, created);
  return task;
}
async function deleteLocal(store, id) {
  const raw = await store.getRawTasks();
  const before = raw.find((t) => t.id === id);
  const { tasks } = OfflineLogic.deleteTask(raw, id);
  await store.saveRawTasks(tasks);
  if (before.google_event_id) {
    await store.enqueue('delete', id, null, before.updated_at);
  } else {
    // Wie Offline.mutate() im Browser: ein noch nie synchronisierter Task nimmt seine eigenen,
    // noch wartenden Warteschlangen-Einträge (z. B. „create“) beim Löschen gleich mit.
    for (const e of await store.getOutbox()) if (e.taskId === id) await store.removeOutboxEntry(e.seq);
  }
}

const findByTitle = (list, title) => list.find((t) => t.title === title);
let remote;
test.beforeEach(() => { remote = fakeRemote(); });

test('Task mit Datum wird als ganztägiges Event mit versteckten Zusatzfeldern angelegt', async () => {
  const store = fakeStore();
  await createLocal(store, { title: 'Steckdose setzen', due_date: '2031-03-10', category: 'Elektrik', color: '5' });
  await S.syncWith(store, remote);
  const [ev] = remote.active();
  assert.strictEqual(ev.summary, 'Steckdose setzen');
  assert.deepStrictEqual(ev.start, { date: '2031-03-10' });
  assert.strictEqual(ev.colorId, '5');
  assert.strictEqual(ev.extendedProperties.private.category, 'Elektrik');
  assert.strictEqual((await store.getOutbox()).length, 0);
});

test('Task ohne Datum synct trotzdem (versteckter Platzhalter-Termin), Datum setzen/entfernen wirkt in Google', async () => {
  const store = fakeStore();
  const t = await createLocal(store, { title: 'Irgendwann' });
  await S.syncWith(store, remote);
  // Ohne Datum bekommt der Task trotzdem ein Event – sonst wäre er auf dieses eine Gerät beschränkt,
  // da es keinen zentralen Server mehr gibt, der ihn für andere Geräte vorhält.
  assert.strictEqual(remote.active().length, 1);
  let ev = remote.active()[0];
  assert.strictEqual(ev.start.date, '1970-01-01');
  assert.strictEqual(ev.extendedProperties.private.noDate, 'true');
  assert.strictEqual(ev.visibility, 'private');
  const sameEventId = ev.id;

  await updateLocal(store, t.id, { due_date: '2031-04-01' });
  await S.syncWith(store, remote);
  ev = remote.active()[0];
  assert.strictEqual(remote.active().length, 1);
  assert.strictEqual(ev.id, sameEventId); // dasselbe Event wird nur umdatiert, nicht neu angelegt
  assert.strictEqual(ev.start.date, '2031-04-01');
  assert.strictEqual(ev.extendedProperties.private.noDate, '');

  await updateLocal(store, t.id, { due_date: null });
  await S.syncWith(store, remote);
  ev = remote.active()[0];
  assert.strictEqual(ev.id, sameEventId);
  assert.strictEqual(ev.start.date, '1970-01-01');
  assert.strictEqual(ev.extendedProperties.private.noDate, 'true');
});

test('ZWEITES GERÄT übernimmt einen datumslosen Task korrekt (kein Platzhalterdatum sichtbar)', async () => {
  const deviceA = fakeStore();
  const deviceB = fakeStore();
  await createLocal(deviceA, { title: 'Muffe kaufen', notes: 'Baumarkt' });
  await S.syncWith(deviceA, remote);
  await S.syncWith(deviceB, remote);
  const onB = (await deviceB.getRawTasks())[0];
  assert.strictEqual(onB.title, 'Muffe kaufen');
  assert.strictEqual(onB.due_date, null);
  assert.strictEqual(onB.notes, 'Baumarkt');
});


test('Abhaken: ✓ und grau in Google, Rückgängig stellt die echte Farbe wieder her', async () => {
  const store = fakeStore();
  const t = await createLocal(store, { title: 'Wand streichen', due_date: '2031-03-10', color: '6' });
  await S.syncWith(store, remote);
  await doneLocal(store, t.id, true);
  await S.syncWith(store, remote);
  let ev = remote.active()[0];
  assert.strictEqual(ev.summary, '✓ Wand streichen');
  assert.strictEqual(ev.colorId, '8');

  await doneLocal(store, t.id, false);
  await S.syncWith(store, remote);
  ev = remote.active()[0];
  assert.strictEqual(ev.summary, 'Wand streichen');
  assert.strictEqual(ev.colorId, '6');
});

test('Serie: Folgetermin ab altem Fälligkeitsdatum, kein Duplikat bei erneutem Sync', async () => {
  const store = fakeStore();
  const t = await createLocal(store, {
    title: 'Heizung prüfen', due_date: '2031-09-09', recurrence: { type: 'monthly_weekday', nth: 2, weekday: 2 },
  });
  await S.syncWith(store, remote);
  await doneLocal(store, t.id, true);
  await S.syncWith(store, remote);

  const open = (await store.getRawTasks()).filter((x) => !x.done);
  assert.strictEqual(open.length, 1);
  assert.strictEqual(open[0].due_date, '2031-10-14');
  assert.strictEqual(remote.active().length, 2);

  await S.syncWith(store, remote); // erneuter Sync darf nichts verdoppeln
  assert.strictEqual((await store.getRawTasks()).length, 2);
});

test('Löschen wirkt in beide Richtungen, auch bei einem datumslosen Task', async () => {
  const store = fakeStore();
  const a = await createLocal(store, { title: 'A', due_date: '2031-03-10' });
  const b = await createLocal(store, { title: 'B' }); // ohne Datum, bekommt trotzdem ein (verstecktes) Event
  await S.syncWith(store, remote);
  assert.strictEqual(remote.active().length, 2);

  await deleteLocal(store, a.id);
  await deleteLocal(store, b.id);
  assert.strictEqual((await store.getOutbox()).length, 2); // beide haben inzwischen ein Event, brauchen also einen Löschauftrag
  await S.syncWith(store, remote);
  assert.strictEqual(remote.active().length, 0);
  assert.strictEqual((await store.getRawTasks()).length, 0);
});

test('Löschen eines noch nie synchronisierten Tasks hinterlässt keine Spur', async () => {
  const store = fakeStore();
  const b = await createLocal(store, { title: 'Ganz frisch' }); // noch kein Sync gelaufen, noch kein Event
  await deleteLocal(store, b.id);
  assert.strictEqual((await store.getOutbox()).length, 0); // kein Löschauftrag nötig, es gab ja noch nichts bei Google
  await S.syncWith(store, remote);
  assert.strictEqual(remote.active().length, 0);
  assert.strictEqual((await store.getRawTasks()).length, 0);
});

test('Zuständigkeit erscheint als Kürzel im Kalendertitel und wird beim Sync wieder herausgelöst', async () => {
  const store = fakeStore();
  await createLocal(store, { title: 'Rasen mähen', due_date: '2031-06-01', assignee: 'Hannes' });
  await S.syncWith(store, remote);
  const ev = remote.active()[0];
  assert.strictEqual(ev.summary, 'Rasen mähen (H)');
  assert.strictEqual(ev.extendedProperties.private.assignee, 'Hannes');

  const t = (await store.getRawTasks())[0];
  assert.strictEqual(t.title, 'Rasen mähen'); // eigener Titel bleibt sauber, ohne „(H)“
  assert.strictEqual(t.assignee, 'Hannes');

  // Erledigt + Kürzel gemeinsam: „✓ “ vorne, „(H)“ hinten, beide unabhängig lösbar.
  await doneLocal(store, t.id, true);
  await S.syncWith(store, remote);
  assert.strictEqual(remote.active()[0].summary, '✓ Rasen mähen (H)');
});

test('Direkt in Google „Task (C)“ getippt: Zuständigkeit wird auch ohne extendedProperties erkannt', async () => {
  const store = fakeStore();
  await remote.insert({ summary: 'Einkaufen (C)', start: { date: '2031-07-01' }, end: { date: '2031-07-02' } });
  await S.syncWith(store, remote);
  const t = (await store.getRawTasks())[0];
  assert.strictEqual(t.title, 'Einkaufen');
  assert.strictEqual(t.assignee, 'Caro');
});

test('Kategorien/Orte werden über einen versteckten Termin geteilt', async () => {
  const store = fakeStore();
  await store.saveConfig({ categories: { Garten: '10' }, locations: ['Keller'], updated_at: new Date().toISOString() });
  await S.syncWith(store, remote);
  const cfg = await remote.readConfig();
  assert.deepStrictEqual(cfg.categories, { Garten: '10' });

  // Ein zweites Gerät liest dieselbe Konfiguration
  const store2 = fakeStore();
  await S.syncWith(store2, remote);
  assert.deepStrictEqual((await store2.getConfig()).categories, { Garten: '10' });

  // Der Konfigurations-Termin selbst darf nie als Task auftauchen (siehe Nutzer-Rückmeldung „taucht als
  // Task auf, obwohl er nicht gelöscht werden soll“).
  assert.strictEqual((await store.getRawTasks()).length, 0);
  assert.strictEqual((await store2.getRawTasks()).length, 0);
});

test('Ein fälschlich (ältere App-Version) importierter Konfigurations-Termin wird beim nächsten Sync lokal wieder entfernt, ohne den echten Termin anzurühren', async () => {
  const store = fakeStore();
  await store.saveConfig({ categories: { Garten: '10' }, locations: [], updated_at: new Date().toISOString() });
  await S.syncWith(store, remote);
  const configEventId = (await remote.readConfig()).id;

  // Simuliert den alten Fehler: der Termin wurde einmal fälschlich als Task gespeichert.
  await store.saveRawTasks([{
    id: 'buggy-1', title: '⚙️ Haus-Tasks Einstellungen (bitte nicht löschen oder bearbeiten)', due_date: '1970-01-01',
    category: null, location: null, priority: 'mittel', color: '9', notes: '', checklist: [], done: false, done_at: null,
    recurrence: null, series_id: null, next_task_id: null, google_event_id: configEventId, google_updated: null,
    deleted: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }]);

  await S.syncWith(store, remote);
  assert.strictEqual((await store.getRawTasks()).length, 0, 'die lokale Fehl-Zeile muss verschwinden');
  assert.ok(remote.active().find((e) => e.id === configEventId), 'der echte Kalendertermin bleibt erhalten');
  assert.deepStrictEqual((await remote.readConfig()).categories, { Garten: '10' }, 'die Konfiguration bleibt intakt');
});

test('ZWEI GERÄTE: gleichzeitige Änderungen an unterschiedlichen Feldern überschreiben sich nicht', async () => {
  const deviceA = fakeStore();
  const deviceB = fakeStore();

  await createLocal(deviceA, { title: 'Konflikttest', due_date: '2031-03-10', category: 'Elektrik', location: 'Keller' });
  await S.syncWith(deviceA, remote);
  await S.syncWith(deviceB, remote); // B lernt den Task von Google kennen
  const taskOnB = findByTitle(await deviceB.getRawTasks(), 'Konflikttest');

  // A ändert den Titel, B (unabhängig, „gleichzeitig“) ändert den Ort – beide synchronisieren danach.
  const taskOnA = findByTitle(await deviceA.getRawTasks(), 'Konflikttest');
  await updateLocal(deviceA, taskOnA.id, { title: 'Von Gerät A umbenannt' });
  await updateLocal(deviceB, taskOnB.id, { location: 'Garten' });

  await S.syncWith(deviceA, remote);
  await S.syncWith(deviceB, remote);
  await S.syncWith(deviceA, remote); // A holt sich noch B's Änderung ab

  const ev = remote.active()[0];
  assert.strictEqual(ev.summary, 'Von Gerät A umbenannt');
  assert.strictEqual(ev.extendedProperties.private.location, 'Garten');
  assert.strictEqual(ev.extendedProperties.private.category, 'Elektrik'); // von keinem der beiden angefasst, bleibt erhalten

  const finalA = findByTitle(await deviceA.getRawTasks(), 'Von Gerät A umbenannt');
  assert.strictEqual(finalA.location, 'Garten');
});

test('ZWEI GERÄTE: Serie wird nur einmal fortgesetzt, egal wer zuerst abhakt', async () => {
  const deviceA = fakeStore();
  const deviceB = fakeStore();
  const t = await createLocal(deviceA, { title: 'Mülltonne raus', due_date: '2031-06-02', recurrence: { type: 'weekly' } });
  await S.syncWith(deviceA, remote);
  await S.syncWith(deviceB, remote);

  await doneLocal(deviceA, t.id, true);
  await S.syncWith(deviceA, remote);
  await S.syncWith(deviceB, remote); // B bekommt „erledigt“ + neuen Folgetermin von Google mit

  const doneCount = (await deviceB.getRawTasks()).filter((x) => x.title === 'Mülltonne raus' && x.done).length;
  const openCount = (await deviceB.getRawTasks()).filter((x) => x.title === 'Mülltonne raus' && !x.done).length;
  assert.strictEqual(doneCount, 1);
  assert.strictEqual(openCount, 1);
  assert.strictEqual(remote.active().length, 2);
});

test('Direkt in Google abgehakt (nicht über die App): wird übernommen, Serie läuft aber nicht automatisch weiter', async () => {
  // Bewusste Einschränkung: Nur das Gerät, auf dem in der App abgehakt wird, legt den Folgetermin an
  // (siehe Kommentar in applyRemoteEvent) – sonst würden mehrere Geräte denselben Folgetermin doppelt
  // anlegen. Wer direkt in Googles eigener Oberfläche „✓ “ voranstellt, beendet die Serie also.
  const store = fakeStore();
  const t = await createLocal(store, { title: 'Filter tauschen', due_date: '2031-05-05', recurrence: { type: 'weekly' } });
  await S.syncWith(store, remote);
  remote.editDirect(findByTitle(await store.getRawTasks(), 'Filter tauschen').google_event_id, { summary: '✓ Filter tauschen', colorId: '8' });
  await S.syncWith(store, remote);
  const tasks = await store.getRawTasks();
  assert.strictEqual(tasks.length, 1);
  assert.strictEqual(tasks[0].done, true);
});

test('Clash-Erkennung meldet eine zwischenzeitliche Fremdänderung', async () => {
  const store = fakeStore();
  const t = await createLocal(store, { title: 'X', due_date: '2031-03-10' });
  await S.syncWith(store, remote);
  remote.editDirect(t.google_event_id ?? findByTitle(await store.getRawTasks(), 'X').google_event_id, { summary: 'Von außen geändert' });

  const taskNow = findByTitle(await store.getRawTasks(), 'Von außen geändert') || findByTitle(await store.getRawTasks(), 'X');
  await updateLocal(store, taskNow.id, { notes: 'Notiz' });
  const r = await S.syncWith(store, remote);
  assert.strictEqual(r.clashes.length, 1);
});

test('Abgelaufenes syncToken (410) löst einen vollständigen Abgleich aus', async () => {
  const store = fakeStore();
  const t = await createLocal(store, { title: 'X', due_date: '2031-03-10' });
  await S.syncWith(store, remote);
  await store.setMeta('sync_token', 'abgelaufen');
  const origList = remote.listChanges.bind(remote);
  remote.listChanges = async (token) => {
    if (token === 'abgelaufen') throw Object.assign(new Error('Gone'), { status: 410 });
    return origList(token);
  };
  remote.editDirect((await store.getRawTasks())[0].google_event_id, { summary: 'Neu' });
  await S.syncWith(store, remote);
  assert.strictEqual(findByTitle(await store.getRawTasks(), 'Neu') !== undefined, true);
});
