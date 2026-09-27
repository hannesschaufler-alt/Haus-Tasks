const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');

process.env.HAUS_TASKS_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'haus-tasks-chk-'));

const { db } = require('../db');
const tasks = require('../tasks');
const { ValidationError } = require('../errors');

test.beforeEach(() => db.exec('DELETE FROM tasks'));

test('Checkliste wird gespeichert, Leerpunkte fallen weg, Texte werden getrimmt', () => {
  const t = tasks.createTask({
    title: 'Bad renovieren',
    checklist: [{ text: ' Fliesen kaufen ', done: false }, { text: '   ' }, { text: 'Silikon', done: true }],
  });
  assert.deepStrictEqual(t.checklist, [{ text: 'Fliesen kaufen', done: false }, { text: 'Silikon', done: true }]);
  assert.deepStrictEqual(tasks.getTask(t.id).checklist, t.checklist);
});

test('Task ohne Checkliste hat eine leere Liste', () => {
  assert.deepStrictEqual(tasks.createTask({ title: 'X' }).checklist, []);
});

test('Ungültige Checklisten werden abgelehnt', () => {
  assert.throws(() => tasks.createTask({ title: 'X', checklist: 'kein Array' }), ValidationError);
  assert.throws(() => tasks.createTask({ title: 'X', checklist: [{ text: 'a'.repeat(201) }] }), ValidationError);
  assert.throws(() => tasks.createTask({ title: 'X', checklist: Array.from({ length: 51 }, (_, i) => ({ text: `p${i}` })) }), ValidationError);
});

test('Abhaken eines Punktes ändert nur die Checkliste und markiert nichts für Google', () => {
  const t = tasks.createTask({ title: 'X', due_date: '2031-03-10', checklist: [{ text: 'a' }, { text: 'b' }] });
  db.prepare('UPDATE tasks SET dirty = 0 WHERE id = ?').run(t.id); // als bereits synchronisiert
  const u = tasks.updateTask(t.id, { checklist: [{ text: 'a', done: true }, { text: 'b', done: false }] });
  assert.strictEqual(u.checklist[0].done, true);
  assert.strictEqual(u.dirty, false);
});

test('Titel-, Datums- oder Farbänderung markiert weiterhin für den Sync', () => {
  const t = tasks.createTask({ title: 'X', due_date: '2031-03-10' });
  db.prepare('UPDATE tasks SET dirty = 0 WHERE id = ?').run(t.id);
  assert.strictEqual(tasks.updateTask(t.id, { notes: 'nur Notiz' }).dirty, false);
  assert.strictEqual(tasks.updateTask(t.id, { title: 'Neu' }).dirty, true);
});

test('Serie: Folgetermin übernimmt die Checkliste, alle Punkte wieder offen', () => {
  const t = tasks.createTask({
    title: 'Heizung',
    due_date: '2031-05-05',
    recurrence: { type: 'weekly', interval: 1 },
    checklist: [{ text: 'Druck prüfen', done: true }, { text: 'Entlüften', done: true }],
  });
  tasks.setDone(t.id, true);
  const next = tasks.listTasks().find((x) => !x.done);
  assert.deepStrictEqual(next.checklist, [{ text: 'Druck prüfen', done: false }, { text: 'Entlüften', done: false }]);
  assert.strictEqual(tasks.getTask(t.id).checklist.every((i) => i.done), true); // der erledigte bleibt unverändert
});
