const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');

process.env.HAUS_TASKS_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'haus-tasks-cat-'));

const { db } = require('../db');
const categories = require('../categories');
const tasks = require('../tasks');
const { ValidationError } = require('../errors');

test.beforeEach(() => db.exec('DELETE FROM tasks'));

test('Standardkategorien werden beim ersten Start angelegt', () => {
  assert.deepStrictEqual(Object.keys(categories.list()), ['Elektrik', 'Installation', 'Innenausbau', 'Möbel', 'Garten', 'Wartung']);
});

test('Neue Kategorie ist sofort für Tasks nutzbar und liefert ihre Farbe', () => {
  categories.create({ name: '  Reinigung ', color: '4' });
  const t = tasks.createTask({ title: 'Fenster putzen', category: 'Reinigung' });
  assert.strictEqual(t.color, '4');
});

test('Doppelte Namen (auch anders geschrieben), leere Namen und Graphit werden abgelehnt', () => {
  assert.throws(() => categories.create({ name: 'garten', color: '1' }), ValidationError);
  assert.throws(() => categories.create({ name: '   ', color: '1' }), ValidationError);
  assert.throws(() => categories.create({ name: 'Grau', color: '8' }), ValidationError);
});

test('Umbenennen zieht die Tasks mit, Farbe ändert bestehende Tasks nicht', () => {
  categories.create({ name: 'Alt', color: '2' });
  const t = tasks.createTask({ title: 'X', category: 'Alt' });
  categories.update('Alt', { name: 'Neu', color: '11' });
  assert.strictEqual(tasks.getTask(t.id).category, 'Neu');
  assert.strictEqual(tasks.getTask(t.id).color, '2');
  assert.strictEqual(categories.colorOf('Neu'), '11');
  assert.strictEqual(categories.exists('Alt'), false);
});

test('Umbenennen auf einen vorhandenen Namen schlägt fehl, ohne etwas zu ändern', () => {
  categories.create({ name: 'Eins', color: '1' });
  assert.throws(() => categories.update('Eins', { name: 'Garten' }), ValidationError);
  assert.strictEqual(categories.exists('Eins'), true);
});

test('Löschen lässt die Tasks ohne Kategorie stehen', () => {
  categories.create({ name: 'Weg', color: '3' });
  const t = tasks.createTask({ title: 'Y', category: 'Weg' });
  categories.remove('Weg');
  assert.strictEqual(tasks.getTask(t.id).category, null);
  assert.strictEqual(categories.exists('Weg'), false);
});

test('Task mit unbekannter Kategorie wird abgelehnt', () => {
  assert.throws(() => tasks.createTask({ title: 'Z', category: 'Gibt es nicht' }), ValidationError);
});
