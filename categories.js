// Kategorien liegen in der Datenbank. Beim ersten Start werden die Standardkategorien angelegt.
const { db } = require('./db');
const { CATEGORIES: DEFAULTS, COLORS } = require('./config');
const { ValidationError } = require('./errors');

db.exec('CREATE TABLE IF NOT EXISTS categories (name TEXT PRIMARY KEY, color TEXT NOT NULL, position INTEGER NOT NULL)');
if (db.prepare('SELECT COUNT(*) AS c FROM categories').get().c === 0) {
  const ins = db.prepare('INSERT INTO categories (name, color, position) VALUES (?, ?, ?)');
  Object.entries(DEFAULTS).forEach(([name, color], i) => ins.run(name, color, i));
}

// { Name: colorId } in Anzeigereihenfolge
function list() {
  const out = {};
  for (const r of db.prepare('SELECT name, color FROM categories ORDER BY position, name').all()) out[r.name] = r.color;
  return out;
}

const colorOf = (name) => db.prepare('SELECT color FROM categories WHERE name = ?').get(name)?.color ?? null;
const exists = (name) => colorOf(name) !== null;

function cleanName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) throw new ValidationError('Name fehlt');
  if (name.length > 40) throw new ValidationError('Name ist zu lang (max. 40 Zeichen)');
  return name;
}

function cleanColor(raw) {
  const c = String(raw);
  if (!(c in COLORS) || c === '8') throw new ValidationError('Ungültige Farbe'); // 8 (Graphit) ist für „erledigt“ reserviert
  return c;
}

// Ohne Beachtung der Groß-/Kleinschreibung, damit „garten“ und „Garten“ nicht doppelt vorkommen.
function nameTaken(name, except) {
  return db.prepare('SELECT name FROM categories WHERE lower(name) = lower(?)').all(name).some((r) => r.name !== except);
}

function create({ name, color }) {
  const n = cleanName(name);
  if (nameTaken(n)) throw new ValidationError('Diese Kategorie gibt es schon');
  const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM categories').get().p;
  db.prepare('INSERT INTO categories (name, color, position) VALUES (?, ?, ?)').run(n, cleanColor(color ?? '9'), pos);
  return list();
}

// Umbenennen zieht die Tasks mit. Die Farbe gilt nur für neue Tasks, bestehende behalten ihre.
function update(oldName, patch) {
  if (!exists(oldName)) return null;
  const n = 'name' in patch ? cleanName(patch.name) : oldName;
  const color = 'color' in patch ? cleanColor(patch.color) : colorOf(oldName);
  if (n !== oldName && nameTaken(n, oldName)) throw new ValidationError('Diese Kategorie gibt es schon');
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE categories SET name = ?, color = ? WHERE name = ?').run(n, color, oldName);
    if (n !== oldName) db.prepare('UPDATE tasks SET category = ? WHERE category = ?').run(n, oldName);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return list();
}

// Tasks der Kategorie bleiben erhalten und stehen danach ohne Kategorie da.
function remove(name) {
  if (!exists(name)) return null;
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE tasks SET category = NULL WHERE category = ?').run(name);
    db.prepare('DELETE FROM categories WHERE name = ?').run(name);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return list();
}

module.exports = { list, colorOf, exists, create, update, remove };
