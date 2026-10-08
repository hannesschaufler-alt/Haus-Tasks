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
      return { id: ev.id, updated: ev.updated, categories: JSON.parse(p.categories), locations: JSON.parse(p.locations), settings: p.settings ? JSON.parse(p.settings) : {} };
    },
    async writeConfig(id, cfg) {
      const body = {
        summary: '⚙️ Haus-Tasks Einstellungen (bitte nicht löschen oder bearbeiten)',
        start: { date: '1970-01-01' }, end: { date: '1970-01-02' },
        extendedProperties: { private: { appMarker: S.CONFIG_MARKER, categories: JSON.stringify(cfg.categories), locations: JSON.stringify(cfg.locations), settings: JSON.stringify(cfg.settings || {}) } },
      };
      const ev = id ? store({ ...events.get(id), ...body, updated: stamp() }) : store({ ...body, id: `ev${++n}`, updated: stamp() });
      return { id: ev.id, updated: ev.updated };
    },
    async getTimeZone() { return 'Europe/Vienna'; },
    // Testhilfen, die ein zweites, unabhängiges Gerät (oder Google selbst) nachbilden
    editDirect(id, fields) { store({ ...events.get(id), ...fields, updated: stamp() }); },
    active: () => [...events.values()].filter((e) => e.status !== 'cancelled'),
  };
}

// --- Fake-Speicher: ein Gerät (In-Memory statt IndexedDB) ---
// `settings`: optional vorbelegte gemeinsame Einstellungen (siehe SyncCore.DEFAULT_SETTINGS); ohne Angabe gilt
// die Vorgabe der App (Platz am Tagesende für Tasks ohne Uhrzeit AN).
function fakeStore(settings) {
  let tasks = [];
  let outbox = [];
  let seq = 0;
  let meta = {};
  let config = settings ? { categories: {}, locations: [], settings, updated_at: new Date().toISOString() } : null;
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
  // Die meisten Tests prüfen, wie sichtbare Kalendertermine aussehen: ohne ausdrückliche Angabe gilt hier der
  // Haken „In Google Kalender anzeigen“ als gesetzt (die echte App-Vorgabe testen die Tests weiter unten).
  input = { in_calendar: true, ...input };
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
  // Wie Offline.mutate() im Browser: Nebeneffekte von updateTask() (z. B. automatische Später→To-Do-
  // Beförderung beim Setzen eines Datums) müssen mit in den Sync, auch wenn sie nicht im Patch standen.
  const sentPatch = { ...patch };
  for (const k of ['bucket', 'color', 'due_time', 'due_end_time', 'in_calendar']) {
    if (!(k in patch) && (task[k] ?? null) !== (before[k] ?? null)) sentPatch[k] = task[k] ?? null;
  }
  await store.enqueue('update', id, sentPatch, before.updated_at);
  return task;
}
async function doneLocal(store, id, done) {
  const raw = await store.getRawTasks();
  const before = raw.find((t) => t.id === id);
  const { task, tasks, created } = OfflineLogic.setDone(raw, id, done);
  await store.saveRawTasks(tasks);
  // Wie Offline.mutate(): setDone() befüllt due_date beim Abhaken eines datumslosen Tasks, das muss mit.
  await store.enqueue('done', id, { done, due_date: task.due_date }, before.updated_at);
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

// Nur die Task-Events (ohne den versteckten Konfigurations-Termin, der bei vorbelegten Einstellungen mitsynct).
const taskEvents = () => remote.active().filter((e) => e.extendedProperties?.private?.appMarker !== S.CONFIG_MARKER);
const findByTitle = (list, title) => list.find((t) => t.title === title);
let remote;
const HIDDEN_DAY = /^(197[1-9]|198[01])-[0-9]{2}-[0-9]{2}$/; // versteckte Termine liegen irgendwo in den 1970ern (siehe HIDDEN_EPOCH)
test.beforeEach(() => { remote = fakeRemote(); });

test('Task mit Datum wird als ganztägiges Event mit versteckten Zusatzfeldern angelegt', async () => {
  const store = fakeStore({ untimedAtEndOfDay: false });
  await createLocal(store, { title: 'Steckdose setzen', due_date: '2031-03-10', category: 'Elektrik', color: '5' });
  await S.syncWith(store, remote);
  const [ev] = remote.active();
  assert.strictEqual(ev.summary, 'Steckdose setzen');
  assert.deepStrictEqual(ev.start, { date: '2031-03-10', dateTime: null, timeZone: null });
  assert.strictEqual(ev.colorId, '5');
  assert.strictEqual(ev.extendedProperties.private.category, 'Elektrik');
  assert.strictEqual((await store.getOutbox()).length, 0);
});

test('Eine direkt in Google hinzugefügte Uhrzeit wird übernommen, eine spätere Änderung verdirbt das Event nicht', async () => {
  // Echter Vorfall (Auslöser für das due_time-Feature): aus einem vorbereitenden Task wurde ein echter
  // Termin mit fixer Zeit, direkt in Google eingetragen. Google lehnt einen Patch, der nur "date" setzt,
  // ohne ein vorhandenes dateTime/timeZone explizit zu löschen, mit "Invalid start time" ab.
  const store = fakeStore({ untimedAtEndOfDay: false });
  const t = await createLocal(store, { title: 'Wird zum Termin', due_date: '2031-04-01' });
  await S.syncWith(store, remote);
  const [ev] = remote.active();
  remote.editDirect(ev.id, {
    start: { dateTime: '2031-04-01T10:00:00+02:00', timeZone: 'Europe/Vienna' },
    end: { dateTime: '2031-04-01T11:00:00+02:00', timeZone: 'Europe/Vienna' },
  });

  await S.syncWith(store, remote); // pullt die Uhrzeit
  const pulled = (await store.getRawTasks()).find((x) => x.id === t.id);
  assert.strictEqual(pulled.due_time, '10:00');

  // Eine spätere, unabhängige Änderung darf das Event nicht in einen widersprüchlichen Zustand bringen.
  await updateLocal(store, t.id, { notes: 'kurz was geändert' });
  await S.syncWith(store, remote);
  const after = remote.active()[0];
  assert.strictEqual(after.start.date, null);
  assert.ok(after.start.dateTime.startsWith('2031-04-01T10:00'));
});

test('Uhrzeit in der App wieder entfernen macht aus dem Termin wieder einen ganztägigen', async () => {
  const store = fakeStore({ untimedAtEndOfDay: false });
  const t = await createLocal(store, { title: 'Mit Uhrzeit', due_date: '2031-04-01', due_time: '14:30' });
  await S.syncWith(store, remote);
  let ev = remote.active()[0];
  assert.strictEqual(ev.start.date, null);
  assert.ok(ev.start.dateTime.startsWith('2031-04-01T14:30'));

  await updateLocal(store, t.id, { due_time: null });
  await S.syncWith(store, remote);
  ev = remote.active()[0];
  assert.strictEqual(ev.start.date, '2031-04-01');
  assert.strictEqual(ev.start.dateTime, null);
  assert.strictEqual(ev.end.dateTime, null);
});

test('Eine eigene Dauer wird gesendet und beim zweiten Gerät korrekt zurückgelesen, ohne Dauer gilt eine Stunde', async () => {
  const store = fakeStore();
  const t = await createLocal(store, { title: 'Besprechung', due_date: '2031-04-01', due_time: '14:00', due_end_time: '16:00' });
  await S.syncWith(store, remote);
  const ev = remote.active()[0];
  assert.ok(ev.end.dateTime.startsWith('2031-04-01T16:00'));

  const deviceB = fakeStore();
  await S.syncWith(deviceB, remote);
  const onB = (await deviceB.getRawTasks())[0];
  assert.strictEqual(onB.due_time, '14:00');
  assert.strictEqual(onB.due_end_time, '16:00');

  // Dauer wieder entfernen: zurück zur Ein-Stunden-Vorgabe, nicht die alte Endzeit behalten.
  await updateLocal(store, t.id, { due_end_time: null });
  await S.syncWith(store, remote);
  const ev2 = remote.active()[0];
  assert.ok(ev2.end.dateTime.startsWith('2031-04-01T15:00')); // 14:00 + 1 Std. Vorgabe
});

test('Kategorie ändern (z. B. per Mehrfachbearbeitung): die daraus abgeleitete Farbe kommt auch bei Google an', async () => {
  const store = fakeStore();
  const cats = { Elektrik: '5', Garten: '10' };
  const t = await createLocal(store, { title: 'Wird umkategorisiert', due_date: '2031-04-01', category: 'Elektrik' }, cats);
  await S.syncWith(store, remote);
  assert.strictEqual(remote.active()[0].colorId, '5');

  await updateLocal(store, t.id, { category: 'Garten' }, cats); // Farbe wird lokal abgeleitet, steht nicht im Patch
  await S.syncWith(store, remote);
  const ev = remote.active()[0];
  assert.strictEqual(ev.extendedProperties.private.category, 'Garten');
  assert.strictEqual(ev.colorId, '10');
  // ...und beim zweiten Gerät landet dieselbe Farbe, nicht die alte.
  const deviceB = fakeStore();
  await S.syncWith(deviceB, remote);
  assert.strictEqual((await deviceB.getRawTasks())[0].color, '10');
});

test('Task ohne Datum synct trotzdem (versteckter Platzhalter-Termin), Datum setzen/entfernen wirkt in Google', async () => {
  const store = fakeStore({ untimedAtEndOfDay: false });
  const t = await createLocal(store, { title: 'Irgendwann' });
  await S.syncWith(store, remote);
  // Ohne Datum bekommt der Task trotzdem ein Event – sonst wäre er auf dieses eine Gerät beschränkt,
  // da es keinen zentralen Server mehr gibt, der ihn für andere Geräte vorhält.
  assert.strictEqual(taskEvents().length, 1);
  let ev = taskEvents()[0];
  assert.match(ev.start.date, HIDDEN_DAY);
  assert.strictEqual(ev.extendedProperties.private.cal, 'hide');
  assert.strictEqual(ev.visibility, 'private');
  const sameEventId = ev.id;

  // Mit Datum, aber ohne Haken, bleibt der Termin versteckt auf demselben alten Tag; das echte Datum steht in einem Zusatzfeld.
  const hiddenDay = ev.start.date;
  await updateLocal(store, t.id, { due_date: '2031-04-01' });
  await S.syncWith(store, remote);
  ev = taskEvents()[0];
  assert.strictEqual(taskEvents().length, 1);
  assert.strictEqual(ev.id, sameEventId); // dasselbe Event wird nur umgeschrieben, nicht neu angelegt
  assert.strictEqual(ev.start.date, hiddenDay);
  assert.strictEqual(ev.extendedProperties.private.due, '2031-04-01');

  // Haken gesetzt: der Termin zieht an sein echtes Datum.
  await updateLocal(store, t.id, { in_calendar: true });
  await S.syncWith(store, remote);
  ev = taskEvents()[0];
  assert.strictEqual(ev.id, sameEventId);
  assert.strictEqual(ev.start.date, '2031-04-01');
  assert.strictEqual(ev.visibility, 'default');
  assert.strictEqual(ev.extendedProperties.private.cal, 'show');
  assert.strictEqual(ev.extendedProperties.private.due, '');

  // Datum entfernt: Haken fällt mit weg, Termin geht wieder auf den alten Tag (derselbe wie vorher).
  await updateLocal(store, t.id, { due_date: null });
  await S.syncWith(store, remote);
  ev = taskEvents()[0];
  assert.strictEqual(ev.id, sameEventId);
  assert.strictEqual(ev.start.date, hiddenDay);
  assert.strictEqual(ev.extendedProperties.private.due, '');
});

test('Bucket (GTD-Status) synct zwischen Geräten, Events ohne das Feld gelten als "todo"', async () => {
  const store = fakeStore();
  await createLocal(store, { title: 'Idee', bucket: 'inbox' });
  await S.syncWith(store, remote);
  const [ev] = remote.active();
  assert.strictEqual(ev.extendedProperties.private.bucket, 'inbox');

  const deviceB = fakeStore();
  await S.syncWith(deviceB, remote);
  assert.strictEqual((await deviceB.getRawTasks())[0].bucket, 'inbox');

  // Ein Event ganz ohne das Feld (z. B. direkt in Google angelegt, oder von einer älteren App-Version)
  // gilt als ganz normales "To Do".
  const legacyId = 'evLegacy';
  remote.events.set(legacyId, { id: legacyId, summary: 'Direkt in Google', start: { date: '2031-05-05' }, updated: new Date().toISOString() });
  const deviceC = fakeStore();
  await S.syncWith(deviceC, remote);
  assert.strictEqual(findByTitle(await deviceC.getRawTasks(), 'Direkt in Google').bucket, 'todo');
});

test('Abhaken eines datumslosen Tasks macht aus dem versteckten Platzhalter-Termin einen echten, sichtbaren Termin auf heute', async () => {
  const store = fakeStore({ untimedAtEndOfDay: false });
  const t = await createLocal(store, { title: 'Kleinkram' });
  await S.syncWith(store, remote);
  assert.strictEqual(remote.active()[0].visibility, 'private'); // noch versteckt

  const today = new Date().toLocaleDateString('sv-SE');
  await doneLocal(store, t.id, true);
  await S.syncWith(store, remote);
  let ev = remote.active()[0];
  // Das heutige Datum wird dem Task zugewiesen, im Kalender bleibt er aber unsichtbar (kein Haken).
  assert.match(ev.start.date, HIDDEN_DAY);
  assert.strictEqual(ev.extendedProperties.private.due, today);
  assert.match(ev.summary, /^✓ /);

  // Rückgängig machen lässt das Datum bewusst stehen (keine automatische Rückstellung).
  await doneLocal(store, t.id, false);
  await S.syncWith(store, remote);
  ev = remote.active()[0];
  assert.strictEqual(ev.extendedProperties.private.due, today);
  assert.strictEqual(ev.visibility, 'private');
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

test('ZWEITES GERÄT übernimmt das Datum auch, wenn der Termin zwischenzeitlich eine Uhrzeit bekommen hat', async () => {
  const deviceA = fakeStore();
  const deviceB = fakeStore();
  await createLocal(deviceA, { title: 'Termin verdreht', due_date: '2031-05-05' });
  await S.syncWith(deviceA, remote);
  await S.syncWith(deviceB, remote); // Gerät B kennt den Task schon, bevor er verdreht wird

  const [ev] = remote.active();
  remote.editDirect(ev.id, {
    start: { dateTime: '2031-05-05T09:00:00+02:00', timeZone: 'Europe/Vienna' },
    end: { dateTime: '2031-05-05T09:30:00+02:00', timeZone: 'Europe/Vienna' },
  });

  await S.syncWith(deviceB, remote);
  const onB = findByTitle(await deviceB.getRawTasks(), 'Termin verdreht');
  assert.strictEqual(onB.due_date, '2031-05-05'); // aus dateTime gerettet, nicht auf den Platzhalter gefallen
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

// --- Tasks ohne Uhrzeit: Platz am Tagesende statt Ganztagstermin (Einstellung untimedAtEndOfDay) ---

// Wie Offline.setSettings() im Browser: Einstellung ändern und die Konfiguration als „neuer“ markieren.
async function setSetting(store, patch) {
  const cfg = (await store.getConfig()) || { categories: {}, locations: [] };
  await store.saveConfig({ ...cfg, settings: { ...cfg.settings, ...patch }, updated_at: new Date(Date.now() + 60000).toISOString() });
}

test('Standard: Task mit Datum ohne Uhrzeit wird als 25-Minuten-Termin 23:34–23:59 (Platz 0) angelegt, ohne Erinnerung, in der App weiter ohne Uhrzeit', async () => {
  const store = fakeStore();
  await createLocal(store, { title: 'Müll rausbringen', due_date: '2031-03-10', category: 'Haushalt', color: '5' });
  await S.syncWith(store, remote);
  const [ev] = taskEvents();
  assert.deepStrictEqual(ev.start, { date: null, dateTime: '2031-03-10T23:34:00', timeZone: 'Europe/Vienna' }); // Zeitzone des Kalenders, nicht des Geräts
  assert.deepStrictEqual(ev.end, { date: null, dateTime: '2031-03-10T23:59:00', timeZone: 'Europe/Vienna' });
  assert.strictEqual(ev.extendedProperties.private.noTime, 'true');
  assert.deepStrictEqual(ev.reminders, { useDefault: false, overrides: [] }, 'sonst gäbe es für jeden Task eine Benachrichtigung um ~23:30');
  assert.strictEqual(ev.transparency, 'transparent');
  const task = (await store.getRawTasks())[0];
  assert.strictEqual(task.due_time, null, 'die Uhrzeit ist nur ein Platzhalter und bleibt in der App unsichtbar');
  assert.strictEqual(task.time_slot, true);
});

test('Zweites Gerät liest den Platz am Tagesende als „keine Uhrzeit“ (Datum bleibt, Uhrzeit nicht)', async () => {
  const a = fakeStore();
  const b = fakeStore();
  await createLocal(a, { title: 'Filter wechseln', due_date: '2031-03-10' });
  await S.syncWith(a, remote);
  await S.syncWith(b, remote);
  const onB = findByTitle(await b.getRawTasks(), 'Filter wechseln');
  assert.strictEqual(onB.due_date, '2031-03-10');
  assert.strictEqual(onB.due_time, null);
  assert.strictEqual(onB.due_end_time, null);
  // Ein Update von B darf den Platzhalter nicht in eine echte Uhrzeit verwandeln.
  await updateLocal(b, onB.id, { title: 'Filter gewechselt' });
  await S.syncWith(b, remote);
  const [ev] = taskEvents();
  assert.strictEqual(ev.start.dateTime, '2031-03-10T23:34:00');
  assert.strictEqual(ev.extendedProperties.private.noTime, 'true');
});

test('Echte Uhrzeit bleibt unverändert (kein Platzhalter, Erinnerungen unberührt); datumslose Tasks bleiben ganztägige 1970-Platzhalter', async () => {
  const store = fakeStore();
  await createLocal(store, { title: 'Handwerker', due_date: '2031-03-10', due_time: '10:00' });
  await createLocal(store, { title: 'Irgendwann' });
  await S.syncWith(store, remote);
  const timed = taskEvents().find((e) => e.summary === 'Handwerker');
  assert.strictEqual(timed.start.dateTime, '2031-03-10T10:00:00');
  assert.strictEqual(timed.extendedProperties.private.noTime, '');
  assert.deepStrictEqual(timed.reminders, { useDefault: true });
  const undated = taskEvents().find((e) => e.summary === 'Irgendwann');
  assert.match(undated.start.date, HIDDEN_DAY);
  assert.deepStrictEqual(undated.reminders, { useDefault: false, overrides: [] });
});

test('Uhrzeit entfernen / wieder setzen: Task fällt auf den Platzhalter zurück bzw. bekommt eine echte Uhrzeit', async () => {
  const store = fakeStore();
  const t = await createLocal(store, { title: 'Termin', due_date: '2031-03-10', due_time: '09:30' });
  await S.syncWith(store, remote);
  await updateLocal(store, t.id, { due_time: null });
  await S.syncWith(store, remote);
  let ev = taskEvents()[0];
  assert.strictEqual(ev.start.dateTime, '2031-03-10T23:34:00');
  assert.strictEqual(ev.extendedProperties.private.noTime, 'true');
  assert.deepStrictEqual(ev.reminders, { useDefault: false, overrides: [] });

  await updateLocal(store, t.id, { due_time: '14:00' }); // wieder eine echte Uhrzeit
  await S.syncWith(store, remote);
  ev = taskEvents()[0];
  assert.strictEqual(ev.start.dateTime, '2031-03-10T14:00:00');
  assert.strictEqual(ev.extendedProperties.private.noTime, '');
  assert.deepStrictEqual(ev.reminders, { useDefault: true }, 'Erinnerungen laufen wieder nach der Kalender-Vorgabe');
  assert.strictEqual((await store.getRawTasks())[0].due_time, '14:00');
});

test('Einstellung AUS: neue Tasks bleiben Ganztagstermine; bestehende Platzhalter werden zurück auf ganztägig gestellt', async () => {
  const store = fakeStore();
  await createLocal(store, { title: 'Alt', due_date: '2031-03-10' });
  await S.syncWith(store, remote);
  assert.strictEqual(taskEvents()[0].start.dateTime, '2031-03-10T23:34:00');

  await setSetting(store, { untimedAtEndOfDay: false });
  const r = await S.syncWith(store, remote);
  assert.strictEqual(r.slotsUpdated, 1);
  const ev = taskEvents().find((e) => e.summary === 'Alt');
  assert.deepStrictEqual(ev.start, { date: '2031-03-10', dateTime: null, timeZone: null });
  assert.deepStrictEqual(ev.end, { date: '2031-03-11', dateTime: null, timeZone: null });
  assert.strictEqual(ev.extendedProperties.private.noTime, '');
  assert.deepStrictEqual(ev.reminders, { useDefault: true });
  assert.strictEqual((await store.getRawTasks())[0].time_slot, false);

  await createLocal(store, { title: 'Neu', due_date: '2031-03-12' });
  await S.syncWith(store, remote);
  assert.strictEqual(taskEvents().find((e) => e.summary === 'Neu').start.date, '2031-03-12');
});

test('Einstellung AN: bestehende Ganztags-Tasks (auch erledigte) werden einmalig umgestellt, danach ist nichts mehr zu tun', async () => {
  const store = fakeStore({ untimedAtEndOfDay: false });
  await createLocal(store, { title: 'Offen', due_date: '2031-03-10', category: 'Haushalt' });
  const done = await createLocal(store, { title: 'Erledigt', due_date: '2031-03-11' });
  await createLocal(store, { title: 'Echt', due_date: '2031-03-12', due_time: '08:00' });
  await createLocal(store, { title: 'Ohne Datum' });
  await S.syncWith(store, remote);
  await doneLocal(store, done.id, true);
  await S.syncWith(store, remote);
  assert.ok(taskEvents().filter((e) => e.summary !== 'Echt' && e.summary !== 'Ohne Datum').every((e) => e.start.date), 'Ausgangslage: alles ganztägig');

  await setSetting(store, { untimedAtEndOfDay: true });
  const r = await S.syncWith(store, remote);
  assert.strictEqual(r.slotsUpdated, 2, 'nur „Offen“ und „Erledigt“ – nicht die echte Uhrzeit, nicht der datumslose');
  const byTitle = (title) => taskEvents().find((e) => e.summary.replace(/^✓ /, '') === title);
  assert.strictEqual(byTitle('Offen').start.dateTime, '2031-03-10T23:34:00');
  assert.strictEqual(byTitle('Offen').extendedProperties.private.category, 'Haushalt', 'versteckte Zusatzfelder bleiben beim Umstellen erhalten');
  assert.strictEqual(byTitle('Erledigt').start.dateTime, '2031-03-11T23:34:00');
  assert.ok(byTitle('Erledigt').summary.startsWith('✓'), 'erledigt bleibt erledigt');
  assert.strictEqual(byTitle('Echt').start.dateTime, '2031-03-12T08:00:00');
  assert.match(byTitle('Ohne Datum').start.date, HIDDEN_DAY);

  assert.strictEqual((await S.syncWith(store, remote)).slotsUpdated, 0, 'idempotent');
});

test('Umstellung holt vor dem Patch den aktuellen Google-Stand (Fremdänderung bleibt erhalten)', async () => {
  const store = fakeStore({ untimedAtEndOfDay: false });
  await createLocal(store, { title: 'Eilig', due_date: '2031-03-10' });
  await S.syncWith(store, remote);
  const eventId = (await store.getRawTasks())[0].google_event_id;
  remote.editDirect(eventId, { summary: 'Direkt in Google umbenannt' });

  await setSetting(store, { untimedAtEndOfDay: true });
  const r = await S.syncWith(store, remote);
  assert.strictEqual(r.slotsUpdated, 1);
  const ev = taskEvents().find((e) => e.id === eventId);
  assert.strictEqual(ev.summary, 'Direkt in Google umbenannt', 'Fremdänderung darf nicht überschrieben werden');
  assert.strictEqual(ev.start.dateTime, '2031-03-10T23:34:00');
});

test('Umstellung läuft nicht über eine noch nicht gesendete lokale Änderung', async () => {
  const store = fakeStore({ untimedAtEndOfDay: false });
  const t = await createLocal(store, { title: 'Wartend', due_date: '2031-03-10' });
  await S.syncWith(store, remote);
  await setSetting(store, { untimedAtEndOfDay: true });
  await updateLocal(store, t.id, { title: 'Lokal umbenannt' }); // liegt noch in der Warteschlange
  const dirty = new Set((await store.getOutbox()).map((e) => e.taskId));
  const n = await S.reconcileTimeSlots(store, remote, { untimedAtEndOfDay: true, timeZone: 'Europe/Vienna' }, dirty);
  assert.strictEqual(n, 0);
  assert.strictEqual(taskEvents()[0].start.date, '2031-03-10');
  // Der normale Sync sendet erst die Änderung (gleich mit der neuen Darstellung) und hat danach nichts mehr umzustellen.
  const r = await S.syncWith(store, remote);
  assert.strictEqual(taskEvents()[0].summary, 'Lokal umbenannt');
  assert.strictEqual(taskEvents()[0].start.dateTime, '2031-03-10T23:34:00');
  assert.strictEqual(r.slotsUpdated, 0);
});

test('Umstellung vieler Tasks läuft in Portionen (je Sync höchstens 40), der Rest folgt beim nächsten Sync', async () => {
  const store = fakeStore({ untimedAtEndOfDay: false });
  for (let i = 0; i < 45; i++) await createLocal(store, { title: `Task ${i}`, due_date: '2031-03-10' });
  await S.syncWith(store, remote);
  await setSetting(store, { untimedAtEndOfDay: true });
  assert.strictEqual((await S.syncWith(store, remote)).slotsUpdated, 40);
  assert.strictEqual((await S.syncWith(store, remote)).slotsUpdated, 5);
  assert.strictEqual((await S.syncWith(store, remote)).slotsUpdated, 0);
  assert.ok(taskEvents().every((e) => e.extendedProperties.private.noTime === 'true' && e.start.dateTime.startsWith('2031-03-10T2')));
});

test('ZWEI GERÄTE: Einstellung wird über das Konfigurations-Event geteilt und gilt noch im selben Sync', async () => {
  const a = fakeStore();
  const b = fakeStore();
  await createLocal(a, { title: 'Gemeinsam', due_date: '2031-03-10' });
  await S.syncWith(a, remote);
  await S.syncWith(b, remote);
  assert.strictEqual(S.resolveSettings((await b.getConfig())?.settings).untimedAtEndOfDay, true);

  await setSetting(a, { untimedAtEndOfDay: false });
  await S.syncWith(a, remote); // A schreibt die Einstellung ins gemeinsame Konfigurations-Event und stellt um
  assert.strictEqual(taskEvents()[0].start.date, '2031-03-10');

  const r = await S.syncWith(b, remote); // B übernimmt sie und stellt nichts mehr zurück
  assert.strictEqual((await b.getConfig()).settings.untimedAtEndOfDay, false);
  assert.strictEqual(r.slotsUpdated, 0);
  const onB = findByTitle(await b.getRawTasks(), 'Gemeinsam');
  assert.strictEqual(onB.time_slot, false);
  assert.strictEqual(taskEvents()[0].start.date, '2031-03-10');
});

test('Kein Zugriff auf die Kalender-Zeitzone (z. B. offline): Zeitzone des Geräts als Rückfall, Sync läuft trotzdem', async () => {
  remote.getTimeZone = async () => { throw new Error('offline'); };
  const store = fakeStore();
  await createLocal(store, { title: 'Offline angelegt', due_date: '2031-03-10' });
  await S.syncWith(store, remote);
  const ev = taskEvents()[0];
  assert.strictEqual(ev.start.dateTime, '2031-03-10T23:34:00');
  assert.strictEqual(ev.start.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
});

// --- Plätze am Tagesende: 25 Minuten, je 3 Tasks nebeneinander, 4 Plätze von hinten gezählt ---

const SLOT_STARTS = ['23:34', '23:09', '22:44', '22:19'];
const slotStartOf = (ev) => ev.start.dateTime.slice(11, 16);
const slotCounts = () => {
  const counts = {};
  for (const e of taskEvents()) counts[slotStartOf(e)] = (counts[slotStartOf(e)] || 0) + 1;
  return counts;
};

test('Plätze: je 3 Tasks nebeneinander, der vierte beginnt den nächsten Platz davor – jeder Platz 25 Minuten lang', async () => {
  const store = fakeStore();
  for (let i = 0; i < 7; i++) await createLocal(store, { title: `Task ${i}`, due_date: '2031-03-10' });
  await S.syncWith(store, remote);
  assert.deepStrictEqual(slotCounts(), { '23:34': 3, '23:09': 3, '22:44': 1 });
  for (const e of taskEvents()) {
    const minutes = (s) => Number(s.slice(11, 13)) * 60 + Number(s.slice(14, 16));
    assert.strictEqual(minutes(e.end.dateTime) - minutes(e.start.dateTime), 25, 'kürzer als 25 Minuten würde Google nur als Strich zeichnen');
    assert.ok(minutes(e.end.dateTime) <= 23 * 60 + 59, 'endet vor Mitternacht');
  }
  assert.deepStrictEqual(S.slotTimes(0), { start: '23:34', end: '23:59' });
  assert.deepStrictEqual(S.slotTimes(3), { start: '22:19', end: '22:44' });
});

test('Plätze: nur ein Task pro Tag liegt ganz hinten, jeder Tag zählt für sich', async () => {
  const store = fakeStore();
  await createLocal(store, { title: 'Montag', due_date: '2031-03-10' });
  await createLocal(store, { title: 'Dienstag 1', due_date: '2031-03-11' });
  await createLocal(store, { title: 'Dienstag 2', due_date: '2031-03-11' });
  await S.syncWith(store, remote);
  assert.ok(taskEvents().every((e) => slotStartOf(e) === '23:34'));
});

test('Plätze: ab dem 13. Task an einem Tag teilen sich die am wenigsten belegten Plätze, nichts liegt vor 22:19', async () => {
  const store = fakeStore();
  for (let i = 0; i < 14; i++) await createLocal(store, { title: `Task ${i}`, due_date: '2031-03-10' });
  await S.syncWith(store, remote);
  assert.deepStrictEqual(slotCounts(), { '23:34': 4, '23:09': 4, '22:44': 3, '22:19': 3 });
  assert.ok(taskEvents().every((e) => SLOT_STARTS.includes(slotStartOf(e))));
});

test('Plätze bleiben stabil: Löschen/Erledigen anderer Tasks verschiebt nichts, ein neuer Task füllt die Lücke', async () => {
  const store = fakeStore();
  const made = [];
  for (let i = 0; i < 4; i++) made.push(await createLocal(store, { title: `Task ${i}`, due_date: '2031-03-10' }));
  await S.syncWith(store, remote);
  const before = Object.fromEntries(taskEvents().map((e) => [e.summary, slotStartOf(e)]));
  assert.deepStrictEqual(slotCounts(), { '23:34': 3, '23:09': 1 });

  await deleteLocal(store, made[1].id); // einer aus dem ersten Platz fällt weg
  await doneLocal(store, made[3].id, true); // der aus dem zweiten Platz wird erledigt
  await S.syncWith(store, remote);
  const after = Object.fromEntries(taskEvents().map((e) => [e.summary.replace(/^✓ /, ''), slotStartOf(e)]));
  assert.strictEqual(after['Task 0'], before['Task 0']);
  assert.strictEqual(after['Task 2'], before['Task 2']);
  assert.strictEqual(after['Task 3'], before['Task 3'], 'erledigt behält den Platz');

  await createLocal(store, { title: 'Neu', due_date: '2031-03-10' });
  await S.syncWith(store, remote);
  assert.strictEqual(taskEvents().find((e) => e.summary === 'Neu').start.dateTime.slice(11, 16), '23:34', 'die Lücke im ersten Platz wird wieder gefüllt');
});

test('Datum ändern: am neuen Tag wird der Platz neu vergeben (der alte kann dort schon voll sein)', async () => {
  const store = fakeStore();
  for (let i = 0; i < 6; i++) await createLocal(store, { title: `Voll ${i}`, due_date: '2031-03-10' }); // Plätze 0 und 1 voll
  const mover = await createLocal(store, { title: 'Umzieher', due_date: '2031-03-12' }); // ganz hinten (Platz 0)
  await S.syncWith(store, remote);
  assert.strictEqual(slotStartOf(taskEvents().find((e) => e.summary === 'Umzieher')), '23:34');

  await updateLocal(store, mover.id, { due_date: '2031-03-10' });
  await S.syncWith(store, remote);
  const ev = taskEvents().find((e) => e.summary === 'Umzieher');
  assert.strictEqual(ev.start.dateTime, '2031-03-10T22:44:00', 'Plätze 0 und 1 sind an diesem Tag voll, also Platz 2');
});

test('Bereits angelegte 23:58-Platzhalter (frühere Version, ohne Platznummer) werden beim Abgleich auf richtige Plätze verteilt', async () => {
  const opts = { untimedAtEndOfDay: true, timeZone: 'Europe/Vienna' };
  for (let i = 0; i < 4; i++) {
    const body = S.eventBody({ title: `Alt ${i}`, due_date: '2031-03-10', in_calendar: true, priority: 'mittel', color: '9' }, opts);
    body.start = { dateTime: '2031-03-10T23:58:00', timeZone: 'Europe/Vienna' };
    body.end = { dateTime: '2031-03-10T23:59:00', timeZone: 'Europe/Vienna' };
    body.extendedProperties.private.slot = '';
    await remote.insert(body);
  }
  const store = fakeStore();
  const r = await S.syncWith(store, remote);
  assert.strictEqual(r.slotsUpdated, 4);
  assert.deepStrictEqual(slotCounts(), { '23:34': 3, '23:09': 1 });
  assert.strictEqual((await S.syncWith(store, remote)).slotsUpdated, 0, 'danach nichts mehr zu tun');
});

const evByTitle = (title) => taskEvents().find((e) => e.summary === title);
// --- „Unsichtbarer Sync“: nur Tasks mit Haken „In Google Kalender anzeigen“ stehen an ihrem Datum im Kalender ---

test('Neuer Task: Haken standardmäßig aus (Termin versteckt auf altem Tag), mit Uhrzeit automatisch an', async () => {
  const store = fakeStore();
  await createLocal(store, { title: 'Nur zum Merken', due_date: '2031-05-01', in_calendar: undefined });
  await createLocal(store, { title: 'Arzt', due_date: '2031-05-02', due_time: '09:00', in_calendar: undefined });
  await S.syncWith(store, remote);
  const hidden = evByTitle('Nur zum Merken');
  assert.match(hidden.start.date, HIDDEN_DAY);
  assert.strictEqual(hidden.extendedProperties.private.due, '2031-05-01');
  assert.strictEqual(hidden.visibility, 'private');
  assert.deepStrictEqual(hidden.reminders, { useDefault: false, overrides: [] });
  const shown = evByTitle('Arzt');
  assert.strictEqual(shown.start.dateTime, '2031-05-02T09:00:00');
  assert.strictEqual(shown.extendedProperties.private.cal, 'show');
});

test('Versteckter Task kommt mit echtem Datum und Uhrzeit auf dem zweiten Gerät an; Bearbeiten dort lässt den Termin auf seinem Tag', async () => {
  const a = fakeStore();
  const b = fakeStore();
  await createLocal(a, { title: 'Müll rausbringen', due_date: '2031-05-01', due_time: '07:30', in_calendar: false, notes: 'Tonne' });
  await S.syncWith(a, remote);
  const day = taskEvents()[0].start.date;
  await S.syncWith(b, remote);
  const onB = (await b.getRawTasks())[0];
  assert.strictEqual(onB.due_date, '2031-05-01');
  assert.strictEqual(onB.due_time, '07:30');
  assert.strictEqual(onB.in_calendar, false);
  assert.strictEqual(onB.hidden_date, day);

  await updateLocal(b, onB.id, { title: 'Müll und Papier' });
  await S.syncWith(b, remote);
  const ev = taskEvents()[0];
  assert.strictEqual(ev.start.date, day, 'Tag bleibt, obwohl Gerät B die ursprüngliche Task-ID nicht kennt');
  assert.strictEqual(ev.extendedProperties.private.due, '2031-05-01');
  assert.strictEqual(ev.extendedProperties.private.dueTime, '07:30');
  await S.syncWith(a, remote);
  assert.strictEqual((await a.getRawTasks())[0].title, 'Müll und Papier');
  assert.strictEqual((await a.getRawTasks())[0].due_time, '07:30');
});

test('Haken an/aus: Termin wechselt zwischen echtem Datum und verstecktem Tag, Uhrzeit bleibt erhalten', async () => {
  const store = fakeStore();
  const t = await createLocal(store, { title: 'Zahnarzt', due_date: '2031-06-10', due_time: '14:00', in_calendar: true });
  await S.syncWith(store, remote);
  assert.strictEqual(taskEvents()[0].start.dateTime, '2031-06-10T14:00:00');
  await updateLocal(store, t.id, { in_calendar: false });
  await S.syncWith(store, remote);
  let ev = taskEvents()[0];
  assert.match(ev.start.date, HIDDEN_DAY);
  assert.strictEqual(ev.start.dateTime, null);
  await updateLocal(store, t.id, { in_calendar: true });
  await S.syncWith(store, remote);
  ev = taskEvents()[0];
  assert.strictEqual(ev.start.dateTime, '2031-06-10T14:00:00');
  assert.strictEqual(ev.start.date, null);
  assert.strictEqual((await store.getRawTasks())[0].due_time, '14:00');
});

test('Versteckte Tage verteilen sich über viele Tage (nicht alle Tasks an einem Tag)', () => {
  const days = new Set();
  for (let i = 0; i < 300; i++) days.add(S.hiddenDateFor({ id: `task-${i}-${i * 7919}` }));
  assert.ok(days.size > 250, `nur ${days.size} verschiedene Tage für 300 Tasks`);
  for (const d of days) assert.match(d, HIDDEN_DAY);
  assert.strictEqual(S.hiddenDateFor({ id: 'x' }), S.hiddenDateFor({ id: 'x' }), 'stabil');
  assert.strictEqual(S.hiddenDateFor({ id: 'x', hidden_date: '1975-05-05' }), '1975-05-05', 'gemerkter Tag hat Vorrang');
});

test('Umstellung bestehender Tasks: nur Termine mit Uhrzeit bleiben sichtbar, der Rest wandert auf alte Tage; Fremdtermine bleiben', async () => {
  const legacy = (extra, priv) => remote.insert({ colorId: '9', start: { date: '2031-03-10' }, end: { date: '2031-03-11' }, ...extra,
    extendedProperties: { private: { priority: 'mittel', category: 'Haushalt', noDate: '', noTime: '', ...priv } } });
  await legacy({ summary: 'Ganztags alt' });
  await legacy({ summary: 'Platz alt', start: { dateTime: '2031-03-10T23:34:00', timeZone: 'Europe/Vienna' }, end: { dateTime: '2031-03-10T23:59:00', timeZone: 'Europe/Vienna' } }, { noTime: 'true', slot: '0' });
  await legacy({ summary: 'Mit Uhrzeit alt', start: { dateTime: '2031-03-10T10:00:00', timeZone: 'Europe/Vienna' }, end: { dateTime: '2031-03-10T11:00:00', timeZone: 'Europe/Vienna' } });
  await legacy({ summary: 'Undatiert alt', start: { date: '1970-01-01' }, end: { date: '1970-01-02' } }, { noDate: 'true' });
  await remote.insert({ summary: 'Von Hand in Google', start: { date: '2031-03-12' }, end: { date: '2031-03-13' } });

  const store = fakeStore();
  const r = await S.syncWith(store, remote);
  assert.strictEqual(r.calUpdated, 3);
  const ev = (title) => evByTitle(title);
  assert.match(ev('Ganztags alt').start.date, HIDDEN_DAY);
  assert.strictEqual(ev('Ganztags alt').extendedProperties.private.due, '2031-03-10');
  assert.strictEqual(ev('Ganztags alt').extendedProperties.private.category, 'Haushalt', 'versteckte Felder bleiben');
  assert.match(ev('Platz alt').start.date, HIDDEN_DAY);
  assert.strictEqual(ev('Platz alt').start.dateTime, null);
  assert.match(ev('Undatiert alt').start.date, HIDDEN_DAY);
  assert.strictEqual(ev('Mit Uhrzeit alt').start.dateTime, '2031-03-10T10:00:00', 'Termin mit Uhrzeit bleibt sichtbar');
  assert.strictEqual(ev('Von Hand in Google').start.dateTime.slice(0, 10), '2031-03-12', 'fremder Termin bleibt an seinem Tag (nur Platz am Tagesende wie bisher)');

  const tasks = await store.getRawTasks();
  const by = (title) => tasks.find((t) => t.title === title);
  assert.strictEqual(by('Ganztags alt').due_date, '2031-03-10');
  assert.strictEqual(by('Ganztags alt').in_calendar, false);
  assert.strictEqual(by('Mit Uhrzeit alt').in_calendar, true);
  assert.strictEqual(by('Von Hand in Google').in_calendar, true);
  assert.strictEqual(by('Undatiert alt').due_date, null);

  const again = await S.syncWith(store, remote);
  assert.strictEqual(again.calUpdated, 0, 'idempotent');
  assert.strictEqual(again.slotsUpdated, 0, 'die Tagesende-Umstellung fasst Versteckte nicht an');
});

test('Umstellung ist gedrosselt (30 je Sync) und überschreibt keine wartende lokale Änderung', async () => {
  for (let i = 0; i < 45; i++) {
    await remote.insert({ summary: `Alt ${i}`, start: { date: '2031-03-10' }, end: { date: '2031-03-11' }, extendedProperties: { private: { priority: 'mittel' } } });
  }
  const store = fakeStore();
  assert.strictEqual((await S.syncWith(store, remote)).calUpdated, 30);
  assert.strictEqual((await S.syncWith(store, remote)).calUpdated, 15);
  assert.strictEqual((await S.syncWith(store, remote)).calUpdated, 0);

  // Ein Task mit wartender lokaler Änderung (Haken gesetzt) wird von der Umstellung nicht angefasst.
  const t = (await store.getRawTasks())[0];
  await updateLocal(store, t.id, { in_calendar: true });
  await S.reconcileCalendar(store, remote, { untimedAtEndOfDay: false, timeZone: 'Europe/Vienna' }, new Set([t.id]));
  const r = await S.syncWith(store, remote);
  assert.strictEqual(r.pushed, 1);
  assert.strictEqual(remote.events.get(t.google_event_id).start.dateTime.slice(0, 10), '2031-03-10', 'Haken wirkt: Termin liegt jetzt an seinem Tag (Platz am Tagesende)');
});

test('Lokale Tasks aus einer Version ohne Schalter werden beim nächsten Sync abgeleitet und umgestellt', async () => {
  const store = fakeStore();
  await createLocal(store, { title: 'Aus dem Altbestand', due_date: '2031-03-10', in_calendar: true });
  await S.syncWith(store, remote);
  // Altbestand nachbilden: Feld fehlt lokal, Event ist im alten Format (ohne Marker).
  await store.saveRawTasks((await store.getRawTasks()).map((t) => { const { in_calendar, cal_migrate, hidden_date, ...rest } = t; return rest; }));
  const evId = (await store.getRawTasks())[0].google_event_id;
  const priv = { ...remote.events.get(evId).extendedProperties.private, cal: '' };
  remote.editDirect(evId, { start: { date: '2031-03-10', dateTime: null }, end: { date: '2031-03-11', dateTime: null }, extendedProperties: { private: priv } });
  const r = await S.syncWith(store, remote);
  assert.strictEqual(r.calUpdated, 1);
  assert.match(remote.events.get(evId).start.date, HIDDEN_DAY);
  assert.strictEqual((await store.getRawTasks())[0].in_calendar, false);
});

// --- Listen (Tasks, Einkauf, …) ---

test('Einstellungen: Hauptliste „Tasks“ gibt es immer, auch wenn gespeicherte Listen sie nicht enthalten oder kaputt sind', () => {
  assert.deepStrictEqual(S.resolveSettings(undefined).lists, [{ id: 'tasks', name: 'Tasks', color: '9' }]);
  const lists = S.resolveSettings({ lists: [{ id: 'k', name: 'Küche', color: '4' }, { kaputt: true }, null] }).lists;
  assert.deepStrictEqual(lists.map((l) => l.id), ['tasks', 'k']);
  assert.strictEqual(S.resolveSettings({ untimedAtEndOfDay: false }).untimedAtEndOfDay, false);
});

test('Liste eines Tasks wandert zum zweiten Gerät; Listenwechsel kommt dort an; Termine ohne Listenangabe gehören zur Hauptliste', async () => {
  const a = fakeStore();
  const b = fakeStore();
  const t = await createLocal(a, { title: 'Milch', list_id: 'einkauf', in_calendar: false });
  await S.syncWith(a, remote);
  assert.strictEqual(taskEvents()[0].extendedProperties.private.list, 'einkauf');
  await S.syncWith(b, remote);
  assert.strictEqual((await b.getRawTasks())[0].list_id, 'einkauf');

  await updateLocal(b, (await b.getRawTasks())[0].id, { list_id: 'tasks' });
  await S.syncWith(b, remote);
  await S.syncWith(a, remote);
  assert.strictEqual((await a.getRawTasks())[0].list_id, 'tasks');

  const body = taskEvents()[0];
  remote.editDirect(body.id, { extendedProperties: { private: { ...body.extendedProperties.private, list: '' } } });
  await S.syncWith(a, remote);
  assert.strictEqual((await a.getRawTasks())[0].list_id, 'tasks');
  assert.ok(t);
});

test('Listen werden über das Konfigurations-Event geteilt', async () => {
  const a = fakeStore({ lists: [{ id: 'tasks', name: 'Tasks', color: '9' }, { id: 'einkauf', name: 'Einkauf', color: '10' }] });
  const b = fakeStore();
  await S.syncWith(a, remote);
  await S.syncWith(b, remote);
  assert.deepStrictEqual(S.resolveSettings((await b.getConfig()).settings).lists.map((l) => l.name), ['Tasks', 'Einkauf']);
});

test('Ein Termin, den eine ältere App-Version auf den versteckten Tag zurückgeschrieben hat, liefert kein falsches Fälligkeitsdatum', async () => {
  await remote.insert({ summary: 'Kaputt', start: { date: '1975-05-05' }, end: { date: '1975-05-06' },
    extendedProperties: { private: { priority: 'mittel', noDate: '' } } });
  await remote.insert({ summary: 'Kaputt versteckt', start: { date: '1975-05-05' }, end: { date: '1975-05-06' },
    extendedProperties: { private: { priority: 'mittel', cal: 'hide', due: '1975-05-05' } } });
  const store = fakeStore();
  await S.syncWith(store, remote);
  for (const t of await store.getRawTasks()) assert.strictEqual(t.due_date, null, t.title);
});
