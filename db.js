const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { DATA_DIR, DB_FILE } = require('./config');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_FILE);
// Server und Aufgabenplanung greifen aus getrennten Prozessen zu.
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    title           TEXT NOT NULL,
    due_date        TEXT,
    category        TEXT,
    location        TEXT,
    priority        TEXT NOT NULL DEFAULT 'mittel',
    color           TEXT NOT NULL DEFAULT '9',
    notes           TEXT NOT NULL DEFAULT '',
    done            INTEGER NOT NULL DEFAULT 0,
    done_at         TEXT,
    recurrence      TEXT,
    series_id       TEXT,
    next_task_id    INTEGER,
    google_event_id TEXT,
    google_updated  TEXT,
    dirty           INTEGER NOT NULL DEFAULT 1,
    deleted         INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_event ON tasks(google_event_id);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`);

// Spätere Spalten für bestehende Datenbanken nachrüsten.
if (!db.prepare('PRAGMA table_info(tasks)').all().some((c) => c.name === 'checklist')) {
  db.exec("ALTER TABLE tasks ADD COLUMN checklist TEXT NOT NULL DEFAULT '[]'");
}

function getMeta(key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMeta(key, value) {
  if (value === null || value === undefined) {
    db.prepare('DELETE FROM meta WHERE key = ?').run(key);
  } else {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  }
}

module.exports = { db, getMeta, setMeta };
