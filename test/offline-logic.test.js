const test = require('node:test');
const assert = require('node:assert');
const L = require('../public/offline-logic');

const CATS = { Elektrik: '5', Garten: '10' };

test('Neuer Task bekommt eine feste, eindeutige ID und Vorgabewerte', () => {
  const { task, tasks } = L.createTask([], { title: '  Lampe  ', category: 'Elektrik' }, CATS);
  assert.strictEqual(typeof task.id, 'string');
  assert.ok(task.id.length > 0);
  assert.strictEqual(task.google_event_id, null);
  assert.strictEqual(task.title, 'Lampe');
  assert.strictEqual(task.color, '5');
  assert.strictEqual(task.priority, 'mittel');
  assert.deepStrictEqual(tasks, [task]);
});

test('Leerer Titel wird abgelehnt', () => {
  assert.throws(() => L.createTask([], { title: '   ' }, CATS), /Titel fehlt/);
});

test('Zuständigkeit: nur Caro/Hannes werden übernommen, alles andere wird zu „niemand“', () => {
  assert.strictEqual(L.createTask([], { title: 'X', assignee: 'Hannes' }, CATS).task.assignee, 'Hannes');
  assert.strictEqual(L.createTask([], { title: 'X', assignee: 'Jemand Fremdes' }, CATS).task.assignee, null);
  assert.strictEqual(L.createTask([], { title: 'X' }, CATS).task.assignee, null);
  assert.deepStrictEqual(L.ASSIGNEES, ['Caro', 'Hannes']);
});

test('Bucket (GTD-Status): neue Tasks landen standardmäßig in "todo", ungültige Werte auch', () => {
  assert.strictEqual(L.createTask([], { title: 'X' }, CATS).task.bucket, 'todo');
  assert.strictEqual(L.createTask([], { title: 'X', bucket: 'inbox' }, CATS).task.bucket, 'inbox');
  assert.strictEqual(L.createTask([], { title: 'X', bucket: 'quatsch' }, CATS).task.bucket, 'todo');
  assert.deepStrictEqual(L.BUCKETS, ['inbox', 'todo', 'later']);
});

test('Ein Datum zu setzen holt einen Task aus der Liste „Später“ zurück in die Hauptliste', () => {
  const colors = { tasks: '9', spaeter: '6' };
  const { task: t0 } = L.createTask([], { title: 'X', list_id: 'spaeter' }, CATS, colors);
  assert.strictEqual(t0.color, '6');
  const { task: t1 } = L.updateTask([t0], t0.id, { due_date: '2031-01-01' }, CATS, colors);
  assert.strictEqual(t1.list_id, 'tasks');
  assert.strictEqual(t1.color, '9');
  // Wählt der Aufruf die Liste selbst, hat das Vorrang vor der Automatik.
  const { task: t2 } = L.updateTask([t0], t0.id, { due_date: '2031-01-01', list_id: 'spaeter' }, CATS, colors);
  assert.strictEqual(t2.list_id, 'spaeter');
  // Ohne Datumsänderung bleibt der Task in „Später“.
  const { task: t3 } = L.updateTask([t0], t0.id, { notes: 'x' }, CATS, colors);
  assert.strictEqual(t3.list_id, 'spaeter');
});

test('Alter Status „later“ (vor der Liste „Später“): wird beim Anfassen in die Liste „Später“ verschoben, mit Datum in die Hauptliste', () => {
  const colors = { tasks: '9', spaeter: '6' };
  const { task: t0 } = L.createTask([], { title: 'X', bucket: 'later' }, CATS, colors);
  assert.strictEqual(t0.bucket, 'later');
  const { task: t1 } = L.updateTask([t0], t0.id, { notes: 'x' }, CATS, colors);
  assert.deepStrictEqual([t1.list_id, t1.bucket, t1.color], ['spaeter', 'todo', '6']);
  const { task: t2 } = L.updateTask([t0], t0.id, { due_date: '2031-01-01' }, CATS, colors);
  assert.deepStrictEqual([t2.list_id, t2.bucket], ['tasks', 'todo']);
});

test('Serie ohne Datum wird abgelehnt, mit Datum normalisiert', () => {
  assert.throws(() => L.createTask([], { title: 'X', recurrence: { type: 'weekly' } }, CATS), /Datum/);
  const { task } = L.createTask([], { title: 'X', due_date: '2031-09-09', recurrence: { type: 'monthly_weekday' } }, CATS);
  assert.deepStrictEqual([task.recurrence.nth, task.recurrence.weekday], [2, 2]); // 2. Dienstag, aus dem Datum abgeleitet
  assert.ok(task.series_id);
});

test('Uhrzeit nur zusammen mit einem Datum: ohne Datum wird sie verworfen, nicht angenommen', () => {
  assert.strictEqual(L.createTask([], { title: 'X', due_time: '14:30' }, CATS).task.due_time, null);
  assert.strictEqual(L.createTask([], { title: 'X', due_date: '2031-09-09', due_time: '14:30' }, CATS).task.due_time, '14:30');
});

test('Das Datum eines Tasks mit Uhrzeit entfernen löscht automatisch auch die Uhrzeit', () => {
  const { task: t0 } = L.createTask([], { title: 'X', due_date: '2031-09-09', due_time: '14:30' }, CATS);
  const { task: t1 } = L.updateTask([t0], t0.id, { due_date: null }, CATS);
  assert.strictEqual(t1.due_time, null);
  // Eine Uhrzeit ohne (verbleibendes) Datum zu setzen bleibt abgelehnt, genau wie bei einer Serie.
  assert.throws(() => L.updateTask([{ ...t0, due_date: null, due_time: null }], t0.id, { due_time: '09:00' }, CATS), /Uhrzeit/);
});

test('Endzeit: nur zusammen mit Startzeit, nur wenn sie wirklich danach liegt', () => {
  assert.strictEqual(L.createTask([], { title: 'X', due_date: '2031-09-09', due_end_time: '15:00' }, CATS).task.due_end_time, null);
  assert.strictEqual(
    L.createTask([], { title: 'X', due_date: '2031-09-09', due_time: '14:00', due_end_time: '13:00' }, CATS).task.due_end_time,
    null, // vor der Startzeit: verworfen statt negative Dauer
  );
  assert.strictEqual(
    L.createTask([], { title: 'X', due_date: '2031-09-09', due_time: '14:00', due_end_time: '15:30' }, CATS).task.due_end_time,
    '15:30',
  );
});

test('Die Startuhrzeit eines Termins mit Endzeit entfernen löscht auch die Endzeit mit', () => {
  const { task: t0 } = L.createTask([], { title: 'X', due_date: '2031-09-09', due_time: '14:00', due_end_time: '15:30' }, CATS);
  const { task: t1 } = L.updateTask([t0], t0.id, { due_time: null }, CATS);
  assert.strictEqual(t1.due_end_time, null);
});

test('Update übernimmt die Kategoriefarbe nur, wenn keine Farbe mitgegeben wurde', () => {
  const { task: t0 } = L.createTask([], { title: 'X', category: 'Elektrik' }, CATS);
  const { task: t1 } = L.updateTask([t0], t0.id, { category: 'Garten' }, CATS);
  assert.strictEqual(t1.color, '10');
  const { task: t2 } = L.updateTask([t1], t1.id, { category: 'Elektrik', color: '3' }, CATS);
  assert.strictEqual(t2.color, '3');
});

test('setDone ist ein No-op, wenn der Status schon stimmt', () => {
  const { task, tasks } = L.createTask([], { title: 'X' }, CATS);
  const r = L.setDone(tasks, task.id, false);
  assert.strictEqual(r.created, null);
  assert.strictEqual(r.task, task);
});

test('Abhaken eines datumslosen Tasks setzt das heutige Datum, Rückgängig lässt es stehen', () => {
  const { task, tasks } = L.createTask([], { title: 'X' }, CATS);
  assert.strictEqual(task.due_date, null);
  const today = new Date().toLocaleDateString('sv-SE');
  const r1 = L.setDone(tasks, task.id, true);
  assert.strictEqual(r1.task.due_date, today);
  const r2 = L.setDone(r1.tasks, task.id, false);
  assert.strictEqual(r2.task.due_date, today); // bleibt stehen, kein automatisches Zurücksetzen
});

test('Abhaken eines Tasks mit vorhandenem Datum lässt das Datum unverändert', () => {
  const { task, tasks } = L.createTask([], { title: 'X', due_date: '2031-06-06' }, CATS);
  const r = L.setDone(tasks, task.id, true);
  assert.strictEqual(r.task.due_date, '2031-06-06');
});

test('Serie: Abhaken legt den Folgetermin ab dem alten Fälligkeitsdatum an, kein Duplikat bei erneutem Abhaken', () => {
  const { task, tasks: t0 } = L.createTask(
    [], { title: 'Heizung', due_date: '2031-09-09', recurrence: { type: 'monthly_weekday', nth: 2, weekday: 2 } }, CATS
  );
  const r1 = L.setDone(t0, task.id, true);
  const open = r1.tasks.filter((t) => !t.done);
  assert.strictEqual(open.length, 1);
  assert.strictEqual(open[0].due_date, '2031-10-14');
  assert.strictEqual(open[0].series_id, task.series_id);
  assert.notStrictEqual(open[0].id, task.id);

  const r2 = L.setDone(r1.tasks, task.id, false);
  const r3 = L.setDone(r2.tasks, task.id, true);
  assert.strictEqual(r3.tasks.length, 2); // kein zweiter Folgetermin
});

test('Serie: Checkliste wandert in den Folgetermin, aber mit offenen Punkten', () => {
  const { task, tasks: t0 } = L.createTask(
    [], { title: 'X', due_date: '2031-05-05', recurrence: { type: 'weekly' }, checklist: [{ text: 'a', done: true }] }, CATS
  );
  const r = L.setDone(t0, task.id, true);
  assert.deepStrictEqual(r.created.checklist, [{ text: 'a', done: false }]);
});

test('Löschen: nie synchronisierter Task verschwindet komplett, bekannter wird nur markiert', () => {
  const { task: fresh } = L.createTask([], { title: 'Neu' }, CATS);
  assert.deepStrictEqual(L.deleteTask([fresh], fresh.id).tasks, []);

  const known = { ...fresh, google_event_id: 'ev1' };
  const r = L.deleteTask([known], known.id);
  assert.strictEqual(r.tasks[0].deleted, true);
});

test('Kategorie: anlegen, doppelte (auch anders geschrieben) und leere Namen abgelehnt', () => {
  assert.deepStrictEqual(L.createCategory(CATS, 'Möbel', '3'), { ...CATS, Möbel: '3' });
  assert.throws(() => L.createCategory(CATS, 'garten'), /gibt es schon/);
  assert.throws(() => L.createCategory(CATS, '  '), /Name fehlt/);
});

test('Kategorie umbenennen zieht Tasks mit, Löschen lässt sie ohne Kategorie stehen', () => {
  const { task } = L.createTask([], { title: 'X', category: 'Garten' }, CATS);
  const ren = L.updateCategory(CATS, [task], 'Garten', { name: 'Außenbereich' });
  assert.strictEqual(ren.tasks[0].category, 'Außenbereich');
  assert.strictEqual('Garten' in ren.categories, false);

  const del = L.deleteCategory(CATS, [task], 'Garten');
  assert.strictEqual(del.tasks[0].category, null);
});

test('Ort: anlegen, umbenennen, löschen', () => {
  const locs = ['Keller', 'Garten'];
  const { task } = L.createTask([], { title: 'X', location: 'Keller' }, CATS);
  assert.throws(() => L.createLocation(locs, 'garten'), /gibt es schon/);

  const ren = L.updateLocation(locs, [task], 'Keller', { name: 'Souterrain' });
  assert.strictEqual(ren.tasks[0].location, 'Souterrain');

  const del = L.deleteLocation(locs, [task], 'Keller');
  assert.strictEqual(del.tasks[0].location, null);
  assert.deepStrictEqual(del.locations, ['Garten']);
});

test('newId liefert stets unterschiedliche, nichtleere Werte', () => {
  const ids = new Set(Array.from({ length: 50 }, () => L.newId()));
  assert.strictEqual(ids.size, 50);
  for (const id of ids) assert.ok(typeof id === 'string' && id.length > 0);
});

test('Kalender-Haken: neue Tasks aus, mit Uhrzeit automatisch an, ohne Datum nie', () => {
  assert.strictEqual(L.createTask([], { title: 'a', due_date: '2031-01-01' }, {}).task.in_calendar, false);
  assert.strictEqual(L.createTask([], { title: 'b', due_date: '2031-01-01', due_time: '10:00' }, {}).task.in_calendar, true);
  assert.strictEqual(L.createTask([], { title: 'c', due_date: '2031-01-01', in_calendar: true }, {}).task.in_calendar, true);
  assert.strictEqual(L.createTask([], { title: 'd', in_calendar: true }, {}).task.in_calendar, false, 'ohne Datum nichts anzuzeigen');
});

test('Kalender-Haken: Uhrzeit setzen schaltet ein (außer ausdrücklich anders), Datum löschen schaltet aus', () => {
  let { task, tasks } = L.createTask([], { title: 'a', due_date: '2031-01-01' }, {});
  ({ task, tasks } = L.updateTask(tasks, task.id, { due_time: '09:00' }, {}));
  assert.strictEqual(task.in_calendar, true);
  ({ task, tasks } = L.updateTask(tasks, task.id, { in_calendar: false }, {}));
  assert.strictEqual(task.in_calendar, false);
  ({ task, tasks } = L.updateTask(tasks, task.id, { due_time: '10:00' }, {})); // Uhrzeit nur geändert, nicht neu gesetzt
  assert.strictEqual(task.in_calendar, false);
  ({ task, tasks } = L.updateTask(tasks, task.id, { due_time: null, due_date: '2031-02-01' }, {}));
  ({ task, tasks } = L.updateTask(tasks, task.id, { due_time: '08:00', in_calendar: false }, {}));
  assert.strictEqual(task.in_calendar, false, 'ausdrückliche Angabe gewinnt');
  ({ task } = L.updateTask(tasks, task.id, { in_calendar: true }, {}));
  ({ task } = L.updateTask([task], task.id, { due_date: null }, {}));
  assert.strictEqual(task.in_calendar, false);
});

test('Listen: neue Tasks gehören zur Hauptliste „tasks“ und nehmen die Farbe ihrer Liste', () => {
  const colors = { tasks: '9', einkauf: '10' };
  const a = L.createTask([], { title: 'Brot' }, {}, colors).task;
  assert.strictEqual(a.list_id, 'tasks');
  assert.strictEqual(a.color, '9');
  const b = L.createTask([], { title: 'Milch', list_id: 'einkauf', bucket: 'inbox' }, {}, colors).task;
  assert.strictEqual(b.list_id, 'einkauf');
  assert.strictEqual(b.color, '10');
  assert.strictEqual(b.bucket, 'todo', 'Inbox gibt es nur in der Hauptliste');
});

test('Listen: Listenwechsel färbt um; außerhalb der Hauptliste ist alles „todo“, zurück bleibt der Status', () => {
  const colors = { tasks: '9', einkauf: '10' };
  let { task, tasks } = L.createTask([], { title: 'Idee', bucket: 'later' }, {}, colors);
  ({ task, tasks } = L.updateTask(tasks, task.id, { list_id: 'einkauf' }, {}, colors));
  assert.strictEqual(task.list_id, 'einkauf');
  assert.strictEqual(task.color, '10');
  assert.strictEqual(task.bucket, 'todo');
  ({ task } = L.updateTask(tasks, task.id, { list_id: 'tasks' }, {}, colors));
  assert.strictEqual(task.color, '9');
  assert.strictEqual(task.bucket, 'todo');
});

test('Wieder auf „offen“ gestellt: die Checkliste springt zurück auf „nicht erledigt“; beim Abhaken bleibt sie wie sie ist', () => {
  const checklist = [{ text: 'Teig', done: true }, { text: 'Käse', done: true }, { text: 'Tomaten', done: false }];
  const { task: t0 } = L.createTask([], { title: 'Pizza', checklist }, CATS);
  const { task: erledigt, tasks } = L.setDone([t0], t0.id, true);
  assert.deepStrictEqual(erledigt.checklist.map((i) => i.done), [true, true, false], 'Abhaken lässt die Checkliste unberührt');
  const { task: wieder } = L.setDone(tasks, t0.id, false);
  assert.deepStrictEqual(wieder.checklist, [{ text: 'Teig', done: false }, { text: 'Käse', done: false }, { text: 'Tomaten', done: false }]);
  assert.strictEqual(wieder.done, false);
});

test('Einkaufsliste: Zutaten ohne Doppelte und ohne das, was dort schon offen steht', () => {
  const existing = [{ title: 'Käse', done: false }, { title: 'Mehl', done: true }, { title: 'Gelöscht', done: false, deleted: true }];
  const r = L.shoppingItems([{ text: ' käse ' }, { text: 'Mehl' }, { text: 'Gelöscht' }, { text: 'Tomaten', done: true }, { text: 'tomaten' }, { text: '  ' }], existing);
  assert.deepStrictEqual(r.add, ['Mehl', 'Gelöscht', 'Tomaten']); // erledigtes/gelöschtes zählt nicht als „steht schon drauf“
  assert.strictEqual(r.already, 1);
  assert.deepStrictEqual(L.shoppingItems([], []), { add: [], already: 0 });
});

test('Ausdrücklicher Anlegezeitpunkt wird übernommen, ein ungültiger ignoriert', () => {
  assert.strictEqual(L.createTask([], { title: 'A', created_at: '2031-01-02T03:04:05.006Z' }, CATS).task.created_at, '2031-01-02T03:04:05.006Z');
  assert.ok(L.createTask([], { title: 'B', created_at: 'quatsch' }, CATS).task.created_at.startsWith(new Date().getFullYear().toString()));
});
