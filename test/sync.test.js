const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');

process.env.HAUS_TASKS_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'haus-tasks-'));

const { db } = require('../db');
const tasks = require('../tasks');
const { syncWith } = require('../sync');

// Google im Speicher: gleiche Schnittstelle wie der echte Adapter, inkl. syncToken und Löschmarkierungen.
function fakeRemote() {
  const events = new Map();
  let version = 0;
  let n = 0;
  let last = 0;
  const stamp = () => new Date((last = Math.max(Date.now(), last + 1))).toISOString();
  const store = (ev) => { ev._v = ++version; events.set(ev.id, ev); return ev; };
  return {
    events,
    async listChanges(token) {
      if (token === 'abgelaufen') throw Object.assign(new Error('Gone'), { status: 410 });
      const incremental = !!token;
      const items = [...events.values()].filter((e) => (incremental ? e._v > Number(token) : e.status !== 'cancelled'));
      return { events: items.map((e) => ({ ...e })), nextSyncToken: String(version), incremental };
    },
    async insert(body) { return { ...store({ ...body, id: `ev${++n}`, updated: stamp() }) }; },
    async patch(id, body) {
      const cur = events.get(id);
      if (!cur || cur.status === 'cancelled') throw Object.assign(new Error('Not Found'), { status: 404 });
      return { ...store({ ...cur, ...body, updated: stamp() }) };
    },
    async remove(id) { store({ ...events.get(id), status: 'cancelled', updated: stamp() }); },
    // Änderung, die der Nutzer direkt in Google macht
    edit(id, fields) { store({ ...events.get(id), ...fields, updated: stamp() }); },
    active: () => [...events.values()].filter((e) => e.status !== 'cancelled'),
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let remote;
test.beforeEach(() => {
  db.exec('DELETE FROM tasks; DELETE FROM meta;');
  remote = fakeRemote();
});

test('Task mit Datum wird als ganztägiges Event mit Farbe angelegt', async () => {
  const t = tasks.createTask({ title: 'Steckdose setzen', due_date: '2031-03-10', category: 'Elektrik' });
  await syncWith(remote);
  const [ev] = remote.active();
  assert.strictEqual(ev.summary, 'Steckdose setzen');
  assert.deepStrictEqual(ev.start, { date: '2031-03-10' });
  assert.deepStrictEqual(ev.end, { date: '2031-03-11' });
  assert.strictEqual(ev.colorId, '5');
  assert.strictEqual(tasks.getTask(t.id).dirty, false);
});

test('Task ohne Datum bleibt lokal; Datum setzen und entfernen wirkt in Google', async () => {
  const t = tasks.createTask({ title: 'Irgendwann' });
  await syncWith(remote);
  assert.strictEqual(remote.active().length, 0);

  tasks.updateTask(t.id, { due_date: '2031-04-01' });
  await syncWith(remote);
  assert.strictEqual(remote.active().length, 1);

  tasks.updateTask(t.id, { due_date: null });
  await syncWith(remote);
  assert.strictEqual(remote.active().length, 0);
  assert.strictEqual(tasks.getTask(t.id).google_event_id, null);
});

test('Änderungen in Google (Titel, Datum, Farbe) landen in der App', async () => {
  const t = tasks.createTask({ title: 'Alt', due_date: '2031-03-10', category: 'Garten' });
  await syncWith(remote);
  remote.edit(tasks.getTask(t.id).google_event_id, { summary: 'Neu', start: { date: '2031-03-12' }, colorId: '11' });
  await syncWith(remote);
  const after = tasks.getTask(t.id);
  assert.deepStrictEqual([after.title, after.due_date, after.color], ['Neu', '2031-03-12', '11']);
  assert.strictEqual(after.dirty, false);
});

test('Abhaken in der App: ✓ und grau in Google, Rückgängig stellt die Farbe wieder her', async () => {
  const t = tasks.createTask({ title: 'Wand streichen', due_date: '2031-03-10', category: 'Innenausbau' });
  await syncWith(remote);
  tasks.setDone(t.id, true);
  await syncWith(remote);
  let ev = remote.active()[0];
  assert.strictEqual(ev.summary, '✓ Wand streichen');
  assert.strictEqual(ev.colorId, '8');

  tasks.setDone(t.id, false);
  await syncWith(remote);
  ev = remote.active()[0];
  assert.strictEqual(ev.summary, 'Wand streichen');
  assert.strictEqual(ev.colorId, '6');
});

test('Abhaken in Google (✓ im Titel): App zieht nach, ursprüngliche Farbe bleibt gespeichert', async () => {
  const t = tasks.createTask({ title: 'Regal', due_date: '2031-03-10', category: 'Möbel' });
  await syncWith(remote);
  const id = tasks.getTask(t.id).google_event_id;
  remote.edit(id, { summary: '✓ Regal', colorId: '8' });
  await syncWith(remote);
  let after = tasks.getTask(t.id);
  assert.strictEqual(after.done, true);
  assert.strictEqual(after.title, 'Regal');
  assert.strictEqual(after.color, '3');

  remote.edit(id, { summary: 'Regal' }); // ✓ wieder entfernt, Farbe blieb Graphit
  await syncWith(remote);
  await syncWith(remote); // zweiter Lauf schiebt die korrigierte Farbe nach Google
  after = tasks.getTask(t.id);
  assert.strictEqual(after.done, false);
  assert.strictEqual(after.color, '3');
  assert.strictEqual(remote.active()[0].colorId, '3');
});

test('Serie: Folgetermin ab altem Fälligkeitsdatum, erst nach dem Abhaken in Google', async () => {
  const t = tasks.createTask({
    title: 'Heizung prüfen',
    due_date: '2031-09-09',
    category: 'Wartung',
    recurrence: { type: 'monthly_weekday', nth: 2, weekday: 2 },
  });
  await syncWith(remote);
  assert.strictEqual(remote.active().length, 1);

  tasks.setDone(t.id, true);
  await syncWith(remote);
  const open = tasks.listTasks().filter((x) => !x.done);
  assert.strictEqual(open.length, 1);
  assert.strictEqual(open[0].due_date, '2031-10-14');
  assert.strictEqual(open[0].series_id, tasks.getTask(t.id).series_id);
  assert.strictEqual(remote.active().length, 2);

  // Wieder öffnen und erneut abhaken erzeugt keinen zweiten Folgetermin
  tasks.setDone(t.id, false);
  tasks.setDone(t.id, true);
  assert.strictEqual(tasks.listTasks().length, 2);
});

test('Serie, in Google abgehakt, erzeugt ebenfalls den Folgetermin', async () => {
  const t = tasks.createTask({ title: 'Filter', due_date: '2031-05-05', recurrence: { type: 'weekly', interval: 1 } });
  await syncWith(remote);
  remote.edit(tasks.getTask(t.id).google_event_id, { summary: '✓ Filter', colorId: '8' });
  await syncWith(remote);
  const open = tasks.listTasks().filter((x) => !x.done);
  assert.deepStrictEqual(open.map((x) => x.due_date), ['2031-05-12']);
});

test('Löschen wirkt in beide Richtungen', async () => {
  const a = tasks.createTask({ title: 'A', due_date: '2031-03-10' });
  const b = tasks.createTask({ title: 'B', due_date: '2031-03-11' });
  await syncWith(remote);

  tasks.deleteTask(a.id);
  await syncWith(remote);
  assert.strictEqual(remote.active().length, 1);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM tasks WHERE id=?').get(a.id).c, 0);

  remote.edit(tasks.getTask(b.id).google_event_id, { status: 'cancelled' });
  await syncWith(remote);
  assert.strictEqual(tasks.getTask(b.id), null);
});

test('Lokal jüngere Änderung gewinnt gegen ältere Google-Änderung', async () => {
  const t = tasks.createTask({ title: 'Original', due_date: '2031-03-10' });
  await syncWith(remote);
  remote.edit(tasks.getTask(t.id).google_event_id, { summary: 'Von Google' });
  await wait(5);
  tasks.updateTask(t.id, { title: 'Von der App' });
  await syncWith(remote);
  assert.strictEqual(tasks.getTask(t.id).title, 'Von der App');
  assert.strictEqual(remote.active()[0].summary, 'Von der App');
});

test('Abgelaufenes syncToken (410) löst einen vollständigen Abgleich aus', async () => {
  const t = tasks.createTask({ title: 'X', due_date: '2031-03-10' });
  await syncWith(remote);
  require('../db').setMeta('sync_token', 'abgelaufen');
  remote.edit(tasks.getTask(t.id).google_event_id, { summary: 'Y' });
  await syncWith(remote);
  assert.strictEqual(tasks.getTask(t.id).title, 'Y');
});

test('In Google gelöschtes Event wird beim Vollabgleich lokal entfernt', async () => {
  const t = tasks.createTask({ title: 'Weg', due_date: '2031-03-10' });
  await syncWith(remote);
  remote.events.delete(tasks.getTask(t.id).google_event_id); // spurlos, kein Tombstone
  require('../db').setMeta('sync_token', null);
  await syncWith(remote);
  assert.strictEqual(tasks.getTask(t.id), null);
});
