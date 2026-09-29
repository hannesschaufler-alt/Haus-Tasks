// Reine Nachbildung der Server-Regeln (tasks.js/categories.js/locations.js) für Änderungen ohne
// Serververbindung. Arbeitet nur mit einfachen Objekten/Arrays, keine IndexedDB- oder Netzwerkzugriffe
// hier, damit sich die Regeln wie beim Server mit einfachen Tests absichern lassen. Läuft sowohl unter
// Node (Tests) als auch als <script> im Browser (dort über den globalen Namen `OfflineLogic`).
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./recurrence'));
  else root.OfflineLogic = factory(root.Recurrence);
})(typeof self !== 'undefined' ? self : this, function (Recurrence) {
  const PRIORITIES = ['hoch', 'mittel', 'niedrig'];
  const ASSIGNEES = ['Caro', 'Hannes']; // feste Liste, siehe sync-core.js für die Google-Kalender-Kürzel
  // GTD-Status: 'inbox' (Schnellerfassung, noch nicht einsortiert), 'todo', 'later' ("Später"-Liste).
  const BUCKETS = ['inbox', 'todo', 'later'];

  function uid() {
    if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  const nowIso = () => new Date().toISOString();
  const today = () => new Date().toLocaleDateString('sv-SE');
  const findTask = (tasks, id) => tasks.find((t) => t.id === id);

  function createTask(tasks, input, categories) {
    const title = String(input.title ?? '').trim();
    if (!title) throw new Error('Titel fehlt');
    const category = input.category || null;
    const recurrence = input.recurrence ? Recurrence.normalizeRule(input.recurrence, input.due_date) : null;
    if (recurrence && !input.due_date) throw new Error('Eine Serie braucht ein Datum');
    const task = {
      id: uid(), // ohne zentrale Datenbank bekommt jeder Task hier seine endgültige ID, die sich nie mehr ändert
      title,
      due_date: input.due_date || null,
      category,
      location: input.location || null,
      assignee: ASSIGNEES.includes(input.assignee) ? input.assignee : null,
      priority: PRIORITIES.includes(input.priority) ? input.priority : 'mittel',
      bucket: BUCKETS.includes(input.bucket) ? input.bucket : 'todo',
      color: input.color || (category && categories[category]) || '9',
      notes: String(input.notes ?? ''),
      checklist: Array.isArray(input.checklist) ? input.checklist : [],
      done: false,
      done_at: null,
      recurrence,
      series_id: recurrence ? uid() : null,
      next_task_id: null,
      google_event_id: null,
      google_updated: null,
      deleted: false,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    return { task, tasks: [...tasks, task] };
  }

  function updateTask(tasks, id, patch, categories) {
    const cur = findTask(tasks, id);
    if (!cur) throw new Error('Task nicht gefunden');
    const next = { ...cur, ...patch, updated_at: nowIso() };
    // Kategorie gewechselt, Farbe nicht ausdrücklich mitgegeben: Farbe der neuen Kategorie vorschlagen.
    if (patch.category && patch.category !== cur.category && !('color' in patch)) {
      next.color = categories[patch.category] || cur.color;
    }
    // Ein Datum zu vergeben heißt „jetzt konkret“, nicht mehr „irgendwann“ – ein „Später“-Task wird dadurch
    // automatisch wieder zu einem To-Do, außer der Aufruf ändert den Status ohnehin schon selbst.
    if (patch.due_date && cur.bucket === 'later' && !('bucket' in patch)) {
      next.bucket = 'todo';
    }
    if ('recurrence' in patch) {
      next.recurrence = patch.recurrence ? Recurrence.normalizeRule(patch.recurrence, next.due_date) : null;
      if (next.recurrence && !next.series_id) next.series_id = uid();
    }
    if (next.recurrence && !next.due_date) throw new Error('Eine Serie braucht ein Datum');
    return { task: next, tasks: tasks.map((t) => (t.id === id ? next : t)) };
  }

  // Wie tasks.js: Beim ersten Abhaken eines Serientasks entsteht sofort der Folgetermin, ab dem alten
  // Fälligkeitsdatum. `next_task_id` verhindert einen zweiten Folgetermin bei erneutem Abhaken.
  function setDone(tasks, id, done) {
    const cur = findTask(tasks, id);
    if (!cur) throw new Error('Task nicht gefunden');
    if (cur.done === !!done) return { task: cur, tasks, created: null };
    const ts = nowIso();
    // Ein datumsloser Task bekommt beim Abhaken das heutige Datum, sonst würde er in Google für immer
    // versteckt bleiben (siehe NO_DATE_PLACEHOLDER in sync-core.js) statt als erledigter Termin sichtbar
    // zu sein. Beim Rückgängig-Machen bleibt das Datum bewusst stehen (kein automatisches Zurücksetzen).
    const due_date = done && !cur.due_date ? today() : cur.due_date;
    let updated = { ...cur, done: !!done, done_at: done ? ts : null, due_date, updated_at: ts };
    let list = tasks.map((t) => (t.id === id ? updated : t));
    let created = null;
    if (done && cur.recurrence && cur.due_date && !cur.next_task_id) {
      const nextDate = Recurrence.nextOccurrence(cur.recurrence, cur.due_date, today());
      created = {
        ...cur,
        id: uid(),
        due_date: nextDate,
        checklist: cur.checklist.map((i) => ({ text: i.text, done: false })),
        done: false,
        done_at: null,
        next_task_id: null,
        google_event_id: null,
        google_updated: null,
        deleted: false,
        created_at: ts,
        updated_at: ts,
      };
      updated = { ...updated, next_task_id: created.id };
      list = list.map((t) => (t.id === id ? updated : t)).concat(created);
    }
    return { task: updated, tasks: list, created };
  }

  // Ein Task ohne google_event_id kennt Google noch nicht (nie synchronisiert oder nie fällig gewesen)
  // und verschwindet einfach lokal wieder. Ein schon bekannter Task wird nur zum Löschen markiert, damit
  // der nächste Sync das passende Kalender-Event noch entfernen kann.
  function deleteTask(tasks, id) {
    const cur = findTask(tasks, id);
    if (!cur) throw new Error('Task nicht gefunden');
    if (!cur.google_event_id) return { tasks: tasks.filter((t) => t.id !== id) };
    return { tasks: tasks.map((t) => (t.id === id ? { ...t, deleted: true, updated_at: nowIso() } : t)) };
  }

  const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
  function cleanName(raw) {
    const name = String(raw ?? '').trim();
    if (!name) throw new Error('Name fehlt');
    return name;
  }

  function createCategory(categories, name, color) {
    const n = cleanName(name);
    if (Object.keys(categories).some((k) => sameName(k, n))) throw new Error('Diese Kategorie gibt es schon');
    return { ...categories, [n]: color || '9' };
  }

  function updateCategory(categories, tasks, oldName, patch) {
    if (!(oldName in categories)) throw new Error('Kategorie nicht gefunden');
    const n = 'name' in patch ? cleanName(patch.name) : oldName;
    if (n !== oldName && Object.keys(categories).some((k) => sameName(k, n))) throw new Error('Diese Kategorie gibt es schon');
    const next = { ...categories };
    delete next[oldName];
    next[n] = 'color' in patch ? patch.color : categories[oldName];
    const tasksNext = n === oldName ? tasks : tasks.map((t) => (t.category === oldName ? { ...t, category: n, updated_at: nowIso() } : t));
    return { categories: next, tasks: tasksNext };
  }

  function deleteCategory(categories, tasks, name) {
    if (!(name in categories)) throw new Error('Kategorie nicht gefunden');
    const next = { ...categories };
    delete next[name];
    const tasksNext = tasks.map((t) => (t.category === name ? { ...t, category: null, updated_at: nowIso() } : t));
    return { categories: next, tasks: tasksNext };
  }

  function createLocation(locations, name) {
    const n = cleanName(name);
    if (locations.some((l) => sameName(l, n))) throw new Error('Diesen Ort gibt es schon');
    return [...locations, n];
  }

  function updateLocation(locations, tasks, oldName, patch) {
    if (!locations.includes(oldName)) throw new Error('Ort nicht gefunden');
    const n = 'name' in patch ? cleanName(patch.name) : oldName;
    if (n !== oldName && locations.some((l) => sameName(l, n))) throw new Error('Diesen Ort gibt es schon');
    const locationsNext = locations.map((l) => (l === oldName ? n : l));
    const tasksNext = n === oldName ? tasks : tasks.map((t) => (t.location === oldName ? { ...t, location: n, updated_at: nowIso() } : t));
    return { locations: locationsNext, tasks: tasksNext };
  }

  function deleteLocation(locations, tasks, name) {
    if (!locations.includes(name)) throw new Error('Ort nicht gefunden');
    const locationsNext = locations.filter((l) => l !== name);
    const tasksNext = tasks.map((t) => (t.location === name ? { ...t, location: null, updated_at: nowIso() } : t));
    return { locations: locationsNext, tasks: tasksNext };
  }

  return {
    newId: uid, createTask, updateTask, setDone, deleteTask,
    createCategory, updateCategory, deleteCategory, createLocation, updateLocation, deleteLocation,
    ASSIGNEES, BUCKETS,
  };
});
