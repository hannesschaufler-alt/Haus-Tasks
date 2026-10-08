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
  // Listen (Tasks, Einkauf, …): jeder Task gehört zu genau einer. Die Hauptliste „tasks“ gibt es immer und nur dort
  // gibt es Inbox/Später; in allen anderen Listen landet alles direkt bei „todo“. Siehe sync-core.js (resolveSettings).
  const MAIN_LIST = 'tasks';
  // „Später“ ist eine ganz normale Liste (früher ein Status der Hauptliste): feste ID, damit alle Geräte dieselbe meinen.
  const LATER_LIST = 'spaeter';

  function uid() {
    if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  const nowIso = () => new Date().toISOString();
  const today = () => new Date().toLocaleDateString('sv-SE');
  const findTask = (tasks, id) => tasks.find((t) => t.id === id);

  // `listColors` (Listen-ID → Farbe) gibt neuen Tasks die Farbe ihrer Liste; ohne Angabe bleibt es bei Vorgabe/Kategorie.
  function createTask(tasks, input, categories, listColors = {}) {
    const title = String(input.title ?? '').trim();
    if (!title) throw new Error('Titel fehlt');
    const category = input.category || null;
    const recurrence = input.recurrence ? Recurrence.normalizeRule(input.recurrence, input.due_date) : null;
    if (recurrence && !input.due_date) throw new Error('Eine Serie braucht ein Datum');
    const list_id = input.list_id || MAIN_LIST;
    const task = {
      id: uid(), // ohne zentrale Datenbank bekommt jeder Task hier seine endgültige ID, die sich nie mehr ändert
      title,
      due_date: input.due_date || null,
      due_time: input.due_date && input.due_time ? input.due_time : null, // ohne Datum ergibt eine Uhrzeit nichts
      due_end_time: input.due_date && input.due_time && input.due_end_time && input.due_end_time > input.due_time ? input.due_end_time : null,
      category,
      location: input.location || null,
      assignee: ASSIGNEES.includes(input.assignee) ? input.assignee : null,
      priority: PRIORITIES.includes(input.priority) ? input.priority : 'mittel',
      bucket: list_id !== MAIN_LIST ? 'todo' : BUCKETS.includes(input.bucket) ? input.bucket : 'todo',
      list_id,
      // „In Google Kalender anzeigen“: aus, außer der Task hat eine Uhrzeit (ein Termin gehört in den Kalender).
      // Ohne Datum gibt es nichts anzuzeigen. Siehe sync-core.js (HIDDEN_EPOCH).
      in_calendar: !!input.due_date && (input.in_calendar === undefined ? !!input.due_time : !!input.in_calendar),
      color: input.color || listColors[list_id] || (category && categories[category]) || '9',
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

  function updateTask(tasks, id, patch, categories, listColors = {}) {
    const cur = findTask(tasks, id);
    if (!cur) throw new Error('Task nicht gefunden');
    const next = { ...cur, ...patch, updated_at: nowIso() };
    // Kategorie gewechselt, Farbe nicht ausdrücklich mitgegeben: Farbe der neuen Kategorie vorschlagen.
    if (patch.category && patch.category !== cur.category && !('color' in patch)) {
      next.color = categories[patch.category] || cur.color;
    }
    // Liste gewechselt: Farbe der neuen Liste übernehmen (außer sie wird ausdrücklich mitgegeben); nur die Hauptliste
    // kennt Inbox/Später, in jeder anderen Liste ist alles „todo“.
    if (patch.list_id && patch.list_id !== (cur.list_id || MAIN_LIST)) {
      if (!('color' in patch) && listColors[patch.list_id]) next.color = listColors[patch.list_id];
      if (patch.list_id !== MAIN_LIST && !('bucket' in patch)) next.bucket = 'todo';
    }
    // Ein Datum zu vergeben heißt „jetzt konkret“, nicht mehr „irgendwann“ – ein Task aus der Liste „Später“ wandert
    // dadurch automatisch in die Hauptliste zurück, außer der Aufruf wählt die Liste ohnehin selbst.
    if (patch.due_date && cur.list_id === LATER_LIST && !('list_id' in patch)) {
      next.list_id = MAIN_LIST;
      if (!('color' in patch) && listColors[MAIN_LIST]) next.color = listColors[MAIN_LIST];
    }
    // Veralteter Status „later“ (vor der Liste „Später“): beim Anfassen in die Liste „Später“ umziehen – mit neuem
    // Datum aber gleich zurück in die Hauptliste (siehe oben).
    if (cur.bucket === 'later' && !('bucket' in patch) && !('list_id' in patch)) {
      next.list_id = patch.due_date ? MAIN_LIST : LATER_LIST;
      next.bucket = 'todo';
      if (!('color' in patch) && listColors[next.list_id]) next.color = listColors[next.list_id];
    }
    // Ohne Datum ergibt eine Uhrzeit nichts – wird das Datum entfernt, fallen Uhrzeit und Endzeit automatisch
    // mit weg. Ohne Startuhrzeit ergibt eine Endzeit ebenso nichts, und eine Endzeit vor/gleich der
    // Startzeit wird verworfen statt einen Termin mit negativer oder leerer Dauer zu erzeugen.
    if ('due_date' in patch && !patch.due_date && !('due_time' in patch)) next.due_time = null;
    // Wird eine Uhrzeit neu gesetzt, schaltet sich der Kalender-Haken von selbst ein (außer der Aufruf sagt etwas
    // anderes); ohne Datum fällt er mit weg.
    if (patch.due_time && !cur.due_time && !('in_calendar' in patch)) next.in_calendar = true;
    if (!next.due_date) next.in_calendar = false;
    if (!next.due_time) next.due_end_time = null;
    else if (next.due_end_time && next.due_end_time <= next.due_time) next.due_end_time = null;
    if ('recurrence' in patch) {
      next.recurrence = patch.recurrence ? Recurrence.normalizeRule(patch.recurrence, next.due_date) : null;
      if (next.recurrence && !next.series_id) next.series_id = uid();
    }
    if (next.recurrence && !next.due_date) throw new Error('Eine Serie braucht ein Datum');
    if (next.due_time && !next.due_date) throw new Error('Eine Uhrzeit braucht ein Datum');
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
        hidden_date: null,
        cal_migrate: false,
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
    ASSIGNEES, BUCKETS, MAIN_LIST, LATER_LIST,
  };
});
