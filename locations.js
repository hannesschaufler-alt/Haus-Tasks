// Orte liegen in der Datenbank. Beim ersten Start werden die Standardorte angelegt.
const { db } = require('./db');
const { LOCATIONS: DEFAULTS } = require('./config');
const { ValidationError } = require('./errors');

db.exec('CREATE TABLE IF NOT EXISTS locations (name TEXT PRIMARY KEY, position INTEGER NOT NULL)');
if (db.prepare('SELECT COUNT(*) AS c FROM locations').get().c === 0) {
  const ins = db.prepare('INSERT INTO locations (name, position) VALUES (?, ?)');
  DEFAULTS.forEach((name, i) => ins.run(name, i));
}

const list = () => db.prepare('SELECT name FROM locations ORDER BY position, name').all().map((r) => r.name);
const exists = (name) => !!db.prepare('SELECT 1 FROM locations WHERE name = ?').get(name);

function cleanName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) throw new ValidationError('Name fehlt');
  if (name.length > 40) throw new ValidationError('Name ist zu lang (max. 40 Zeichen)');
  return name;
}

// Ohne Beachtung der Groß-/Kleinschreibung, damit „keller“ und „Keller“ nicht doppelt vorkommen.
function nameTaken(name, except) {
  return db.prepare('SELECT name FROM locations WHERE lower(name) = lower(?)').all(name).some((r) => r.name !== except);
}

function create({ name }) {
  const n = cleanName(name);
  if (nameTaken(n)) throw new ValidationError('Diesen Ort gibt es schon');
  const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM locations').get().p;
  db.prepare('INSERT INTO locations (name, position) VALUES (?, ?)').run(n, pos);
  return list();
}

// Umbenennen zieht die Tasks mit.
function update(oldName, patch) {
  if (!exists(oldName)) return null;
  const n = 'name' in patch ? cleanName(patch.name) : oldName;
  if (n !== oldName && nameTaken(n, oldName)) throw new ValidationError('Diesen Ort gibt es schon');
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE locations SET name = ? WHERE name = ?').run(n, oldName);
    if (n !== oldName) db.prepare('UPDATE tasks SET location = ? WHERE location = ?').run(n, oldName);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return list();
}

// Tasks des Ortes bleiben erhalten und stehen danach ohne Ort da.
function remove(name) {
  if (!exists(name)) return null;
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE tasks SET location = NULL WHERE location = ?').run(name);
    db.prepare('DELETE FROM locations WHERE name = ?').run(name);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return list();
}

module.exports = { list, exists, create, update, remove };
