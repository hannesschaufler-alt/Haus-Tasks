const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');

process.env.HAUS_TASKS_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'haus-tasks-loc-'));

const { db } = require('../db');
const locations = require('../locations');
const tasks = require('../tasks');
const { ValidationError } = require('../errors');

test.beforeEach(() => db.exec('DELETE FROM tasks'));

test('Standardorte werden beim ersten Start angelegt', () => {
  assert.deepStrictEqual(locations.list(), ['Garten', 'Wohnraum', 'Küche', 'Sanitär', 'Halle', 'Keller', 'Dachboden']);
});

test('Neuer Ort ist sofort für Tasks nutzbar', () => {
  locations.create({ name: ' Carport ' });
  assert.strictEqual(tasks.createTask({ title: 'Dach prüfen', location: 'Carport' }).location, 'Carport');
});

test('Doppelte (auch anders geschriebene) und leere Namen werden abgelehnt', () => {
  assert.throws(() => locations.create({ name: 'keller' }), ValidationError);
  assert.throws(() => locations.create({ name: '  ' }), ValidationError);
});

test('Umbenennen zieht die Tasks mit', () => {
  locations.create({ name: 'Alt' });
  const t = tasks.createTask({ title: 'X', location: 'Alt' });
  locations.update('Alt', { name: 'Neu' });
  assert.strictEqual(tasks.getTask(t.id).location, 'Neu');
  assert.strictEqual(locations.exists('Alt'), false);
});

test('Löschen lässt die Tasks ohne Ort stehen', () => {
  locations.create({ name: 'Weg' });
  const t = tasks.createTask({ title: 'Y', location: 'Weg' });
  locations.remove('Weg');
  assert.strictEqual(tasks.getTask(t.id).location, null);
});

test('Task mit unbekanntem Ort wird abgelehnt', () => {
  assert.throws(() => tasks.createTask({ title: 'Z', location: 'Gibt es nicht' }), ValidationError);
});
