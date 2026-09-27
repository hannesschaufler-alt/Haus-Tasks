const crypto = require('node:crypto');
const { db } = require('./db');
const { PRIORITIES, COLORS } = require('./config');
const { nextOccurrence, normalizeRule } = require('./public/recurrence');
const categories = require('./categories');
const locations = require('./locations');
const { ValidationError } = require('./errors');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RULE_TYPES = ['weekly', 'monthly_weekday', 'monthly_day', 'yearly'];
const MAX_CHECKLIST = 50;

const now = () => new Date().toISOString();
const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD in lokaler Zeit

function fromRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    title: r.title,
    due_date: r.due_date,
    category: r.category,
    location: r.location,
    priority: r.priority,
    color: r.color,
    notes: r.notes,
    checklist: JSON.parse(r.checklist || '[]'),
    done: !!r.done,
    done_at: r.done_at,
    recurrence: r.recurrence ? JSON.parse(r.recurrence) : null,
    series_id: r.series_id,
    next_task_id: r.next_task_id,
    google_event_id: r.google_event_id,
    google_updated: r.google_updated,
    dirty: !!r.dirty,
    deleted: !!r.deleted,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function getTask(id) {
  return fromRow(db.prepare('SELECT * FROM tasks WHERE id = ? AND deleted = 0').get(id));
}

function listTasks() {
  return db.prepare('SELECT * FROM tasks WHERE deleted = 0').all().map(fromRow);
}

// Prüft nur die übergebenen Felder und gibt bereinigte Werte zurück.
function validate(input, current) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);

  if (has('title')) {
    const t = String(input.title ?? '').trim();
    if (!t) throw new ValidationError('Titel fehlt');
    out.title = t;
  }
  if (has('due_date')) {
    const d = input.due_date || null;
    if (d !== null && !DATE_RE.test(d)) throw new ValidationError('Ungültiges Datum');
    out.due_date = d;
  }
  if (has('category')) {
    const c = input.category || null;
    if (c !== null && !categories.exists(c)) throw new ValidationError('Unbekannte Kategorie');
    out.category = c;
  }
  if (has('location')) {
    const l = input.location || null;
    if (l !== null && !locations.exists(l)) throw new ValidationError('Unbekannter Ort');
    out.location = l;
  }
  if (has('priority')) {
    if (!PRIORITIES.includes(input.priority)) throw new ValidationError('Ungültige Priorität');
    out.priority = input.priority;
  }
  if (has('color')) {
    if (!(String(input.color) in COLORS)) throw new ValidationError('Ungültige Farbe');
    out.color = String(input.color);
  }
  if (has('notes')) out.notes = String(input.notes ?? '');

  // Checkliste als „Sub-Tasks light“: [{ text, done }], leere Punkte fallen weg.
  if (has('checklist')) {
    if (!Array.isArray(input.checklist)) throw new ValidationError('Ungültige Checkliste');
    const items = input.checklist
      .map((i) => ({ text: String(i?.text ?? '').trim(), done: !!i?.done }))
      .filter((i) => i.text);
    if (items.length > MAX_CHECKLIST) throw new ValidationError(`Höchstens ${MAX_CHECKLIST} Checklistenpunkte`);
    if (items.some((i) => i.text.length > 200)) throw new ValidationError('Ein Checklistenpunkt ist zu lang (max. 200 Zeichen)');
    out.checklist = items;
  }

  if (has('recurrence')) {
    const due = has('due_date') ? out.due_date : current?.due_date;
    const rule = input.recurrence;
    if (rule) {
      if (!RULE_TYPES.includes(rule.type)) throw new ValidationError('Unbekannter Serientyp');
      if (!due) throw new ValidationError('Eine Serie braucht ein Datum');
      out.recurrence = normalizeRule(rule, due);
    } else {
      out.recurrence = null;
    }
  }
  return out;
}

function createTask(input) {
  const v = validate(input, null);
  if (!v.title) throw new ValidationError('Titel fehlt');
  const category = v.category ?? null;
  const t = {
    title: v.title,
    due_date: v.due_date ?? null,
    category,
    location: v.location ?? null,
    priority: v.priority ?? 'mittel',
    color: v.color ?? (category ? categories.colorOf(category) : '9'),
    notes: v.notes ?? '',
    checklist: v.checklist ?? [],
    recurrence: v.recurrence ?? null,
  };
  if (t.recurrence && !t.due_date) throw new ValidationError('Eine Serie braucht ein Datum');
  const ts = now();
  const res = db
    .prepare(
      `INSERT INTO tasks (title, due_date, category, location, priority, color, notes, checklist, recurrence, series_id, dirty, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    )
    .run(
      t.title, t.due_date, t.category, t.location, t.priority, t.color, t.notes, JSON.stringify(t.checklist),
      t.recurrence ? JSON.stringify(t.recurrence) : null,
      t.recurrence ? crypto.randomUUID() : null,
      ts, ts
    );
  return getTask(Number(res.lastInsertRowid));
}

function updateTask(id, patch) {
  const cur = getTask(id);
  if (!cur) return null;
  const v = validate(patch, cur);
  // Kategorie gewechselt, Farbe nicht ausdrücklich gesetzt: Farbe der neuen Kategorie vorschlagen.
  if (v.category && v.category !== cur.category && !('color' in v)) v.color = categories.colorOf(v.category);

  const merged = { ...cur, ...v };
  if (merged.recurrence && !merged.due_date) throw new ValidationError('Eine Serie braucht ein Datum');
  if (merged.recurrence && !merged.series_id) merged.series_id = crypto.randomUUID();
  if (v.recurrence) merged.recurrence = normalizeRule(v.recurrence, merged.due_date);

  // Nur Titel, Datum und Farbe landen in Google. Alles andere (Notizen, Checkliste, Priorität …) braucht keinen Sync.
  const syncNeeded = cur.dirty || ['title', 'due_date', 'color'].some((k) => merged[k] !== cur[k]);
  db.prepare(
    `UPDATE tasks SET title=?, due_date=?, category=?, location=?, priority=?, color=?, notes=?, checklist=?,
       recurrence=?, series_id=?, dirty=?, updated_at=? WHERE id=?`
  ).run(
    merged.title, merged.due_date, merged.category, merged.location, merged.priority, merged.color, merged.notes,
    JSON.stringify(merged.checklist),
    merged.recurrence ? JSON.stringify(merged.recurrence) : null,
    merged.series_id, syncNeeded ? 1 : 0, now(), id
  );
  return getTask(id);
}

// Abhaken oder wieder öffnen. Bei Serien entsteht beim ersten Abhaken der Folgetermin,
// berechnet ab dem alten Fälligkeitsdatum.
function setDone(id, done) {
  const cur = getTask(id);
  if (!cur) return null;
  if (cur.done === !!done) return cur;
  const ts = now();
  db.prepare('UPDATE tasks SET done=?, done_at=?, dirty=1, updated_at=? WHERE id=?').run(done ? 1 : 0, done ? ts : null, ts, id);

  if (done && cur.recurrence && cur.due_date && !cur.next_task_id) {
    const nextDate = nextOccurrence(cur.recurrence, cur.due_date, today());
    // Die Checkliste kommt mit, alle Punkte sind für die nächste Runde wieder offen.
    const freshChecklist = cur.checklist.map((i) => ({ text: i.text, done: false }));
    const res = db
      .prepare(
        `INSERT INTO tasks (title, due_date, category, location, priority, color, notes, checklist, recurrence, series_id, dirty, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
      )
      .run(cur.title, nextDate, cur.category, cur.location, cur.priority, cur.color, cur.notes,
        JSON.stringify(freshChecklist), JSON.stringify(cur.recurrence), cur.series_id, ts, ts);
    db.prepare('UPDATE tasks SET next_task_id=? WHERE id=?').run(Number(res.lastInsertRowid), id);
  }
  return getTask(id);
}

// Mit Google-Event bleibt eine Markierung stehen, bis der Sync das Event gelöscht hat.
function deleteTask(id) {
  const cur = getTask(id);
  if (!cur) return false;
  if (cur.google_event_id) {
    db.prepare('UPDATE tasks SET deleted=1, dirty=1, updated_at=? WHERE id=?').run(now(), id);
  } else {
    db.prepare('DELETE FROM tasks WHERE id=?').run(id);
  }
  return true;
}

module.exports = { listTasks, getTask, createTask, updateTask, setDone, deleteTask, ValidationError, fromRow, now };
