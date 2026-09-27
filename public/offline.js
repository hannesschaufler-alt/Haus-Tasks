// Lokale Datenhaltung + Sync-Steuerung fürs Handy/den Browser: Tasks und Konfiguration liegen
// gespiegelt in IndexedDB. Änderungen laufen sofort über offline-logic.js in diesen Spiegel und werden
// zusätzlich in eine Warteschlange ("outbox") gelegt, die sync-core.js gegen den geteilten Google-
// Kalender abarbeitet, sobald Anmeldung und Verbindung stehen – automatisch oder über den Sync-Button.
(function (root) {
  const L = root.OfflineLogic;
  const DB_NAME = 'haus-tasks';
  const DB_VERSION = 1;
  const CAL_ID_KEY = 'haus-tasks-calendar-id';
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('tasks')) db.createObjectStore('tasks', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache');
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function reqPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbStore(name, mode) {
    const db = await openDb();
    return db.transaction(name, mode).objectStore(name);
  }

  function txDone(store) {
    return new Promise((resolve, reject) => { store.transaction.oncomplete = resolve; store.transaction.onerror = () => reject(store.transaction.error); });
  }

  // --- sync-core.js-Speicherschnittstelle -----------------------------------------------------------
  async function getRawTasks() { return reqPromise((await idbStore('tasks', 'readonly')).getAll()); }
  async function saveRawTasks(list) {
    const s = await idbStore('tasks', 'readwrite');
    await reqPromise(s.clear());
    for (const t of list) s.put(t);
    return txDone(s);
  }
  async function getMeta(key) { return reqPromise((await idbStore('cache', 'readonly')).get('meta:' + key)); }
  async function setMeta(key, value) {
    const s = await idbStore('cache', 'readwrite');
    if (value == null) s.delete('meta:' + key); else s.put(value, 'meta:' + key);
    return txDone(s);
  }
  async function getConfig() { return reqPromise((await idbStore('cache', 'readonly')).get('config')); }
  async function saveConfig(cfg) {
    const s = await idbStore('cache', 'readwrite');
    s.put(cfg, 'config');
    return txDone(s);
  }
  async function getOutbox() { return (await reqPromise((await idbStore('outbox', 'readonly')).getAll())).sort((a, b) => a.seq - b.seq); }
  async function removeOutboxEntry(seq) {
    const s = await idbStore('outbox', 'readwrite');
    s.delete(seq);
    return txDone(s);
  }
  async function enqueue(entry) {
    const s = await idbStore('outbox', 'readwrite');
    s.add({ ...entry, ts: new Date().toISOString() });
    return txDone(s);
  }

  const store = { getRawTasks, saveRawTasks, getMeta, setMeta, getConfig, saveConfig, getOutbox, removeOutboxEntry };

  // --- Kalender-Einrichtung: die ID des geteilten Kalenders (einmalig pro Gerät) ----------------------
  // Kommt entweder aus einem Einladungslink (?cal=…, siehe haushalt.html) oder wird von Hand eingegeben.
  function getCalendarId() {
    try {
      const fromUrl = new URLSearchParams(location.search).get('cal');
      if (fromUrl) { localStorage.setItem(CAL_ID_KEY, fromUrl); history.replaceState(null, '', location.pathname); }
      return localStorage.getItem(CAL_ID_KEY) || null;
    } catch {
      return null;
    }
  }
  function setCalendarId(id) {
    try { localStorage.setItem(CAL_ID_KEY, id); } catch { /* kein Speicherzugriff, z. B. privater Modus */ }
  }

  const remote = root.GcalRemote.makeGcalRemote(root.Auth.getToken, async () => getCalendarId());

  // --- Für die Anzeige: wie sync-core.js' Sicht, aber ohne zum Löschen markierte Zeilen ---------------
  // Der versteckte Kategorien/Orte-Termin wurde von einer älteren Version dieser Datei fälschlich als
  // Task übernommen (siehe sync-core.js). Ein normaler, nicht-vollständiger Sync liefert nur geänderte
  // Termine, deshalb würde sich eine schon falsch importierte Zeile nicht von selbst korrigieren – hier
  // wird sie beim Laden einmalig dauerhaft entfernt (nur lokal, der echte Kalendertermin bleibt unberührt).
  const CONFIG_TITLE = '⚙️ Haus-Tasks Einstellungen (bitte nicht löschen oder bearbeiten)';
  async function getCachedTasks() {
    const raw = await getRawTasks();
    const stray = raw.filter((t) => t.title === CONFIG_TITLE);
    if (stray.length) {
      await saveRawTasks(raw.filter((t) => t.title !== CONFIG_TITLE));
      const strayIds = new Set(stray.map((t) => t.id));
      for (const e of await getOutbox()) if (strayIds.has(e.taskId)) await removeOutboxEntry(e.seq);
    }
    return raw.filter((t) => !t.deleted && t.title !== CONFIG_TITLE);
  }
  async function configOrEmpty() { return (await getConfig()) || { categories: {}, locations: [] }; }

  function pendingCount() { return getOutbox().then((l) => l.length); }

  // --- Änderungen anwenden: sofort lokal (über offline-logic.js), dazu ggf. ein Warteschlangen-Eintrag ---
  async function mutate(kind, op, args) {
    const raw = await getRawTasks();
    const cfg = await configOrEmpty();

    if (kind === 'task') {
      if (op === 'create') {
        const { task, tasks } = L.createTask(raw, args.input, cfg.categories || {});
        await saveRawTasks(tasks);
        await enqueue({ kind, op, taskId: task.id, patch: args.input });
        return task;
      }
      if (op === 'update') {
        const before = raw.find((t) => t.id === args.id);
        const { task, tasks } = L.updateTask(raw, args.id, args.patch, cfg.categories || {});
        await saveRawTasks(tasks);
        await enqueue({ kind, op, taskId: args.id, patch: args.patch, baseUpdatedAt: before?.updated_at });
        return task;
      }
      if (op === 'done') {
        const before = raw.find((t) => t.id === args.id);
        const { task, tasks, created } = L.setDone(raw, args.id, args.done);
        await saveRawTasks(tasks);
        await enqueue({ kind, op, taskId: args.id, patch: { done: args.done }, baseUpdatedAt: before?.updated_at });
        // Ein Folgetermin einer Serie entsteht rein lokal und braucht einen eigenen Anlege-Auftrag –
        // sync-core.js kennt Serien nicht, es sendet nur, was in der Warteschlange steht.
        if (created) await enqueue({ kind: 'task', op: 'create', taskId: created.id, patch: created });
        return task;
      }
      if (op === 'delete') {
        const before = raw.find((t) => t.id === args.id);
        if (!before?.google_event_id) {
          // Nie synchronisiert: verschwindet einfach, inklusive aller noch wartenden Aufträge dafür.
          for (const e of await getOutbox()) if (e.kind === 'task' && e.taskId === args.id) await removeOutboxEntry(e.seq);
          await saveRawTasks(raw.filter((t) => t.id !== args.id));
        } else {
          await saveRawTasks(L.deleteTask(raw, args.id).tasks);
          await enqueue({ kind, op, taskId: args.id, patch: null, baseUpdatedAt: before.updated_at });
        }
        return null;
      }
    }

    if (kind === 'category' || kind === 'location') {
      const listKey = kind === 'category' ? 'categories' : 'locations';
      const current = cfg[listKey] || (kind === 'category' ? {} : []);
      const fns = kind === 'category' ? { update: L.updateCategory, del: L.deleteCategory } : { update: L.updateLocation, del: L.deleteLocation };
      const touch = async (patchToConfig) => {
        const next = { ...cfg, ...patchToConfig, updated_at: new Date().toISOString() };
        await saveConfig(next);
        return next;
      };

      if (op === 'create') {
        const next = kind === 'category' ? L.createCategory(current, args.name, args.color) : L.createLocation(current, args.name);
        await touch({ [listKey]: next });
        return next;
      }
      if (op === 'update') {
        const r = fns.update(current, raw, args.id, args.patch);
        await saveRawTasks(r.tasks);
        await touch({ [listKey]: r[listKey] });
        return r[listKey];
      }
      if (op === 'delete') {
        const r = fns.del(current, raw, args.id);
        await saveRawTasks(r.tasks);
        await touch({ [listKey]: r[listKey] });
        return r[listKey];
      }
    }
    throw new Error('Unbekannte Operation: ' + kind + ':' + op);
  }

  // --- Bereitschaft & Sync ------------------------------------------------------------------------------
  // Reine Lokal-Prüfung (angemeldet + Kalender eingerichtet), kein Netzwerkaufruf: ob Google gerade
  // wirklich erreichbar ist, zeigt sich erst beim tatsächlichen sync()-Versuch (siehe dessen Fehlerform
  // in index.html: ohne .status vermutlich keine Verbindung, mit .status ein echter Google-Fehler).
  function ping() {
    return root.Auth.isSignedIn() && !!getCalendarId();
  }

  async function sync() {
    return root.SyncCore.syncWith(store, remote);
  }

  root.Offline = {
    init: openDb,
    getCachedTasks,
    getConfig,
    saveConfig,
    pendingCount,
    mutate,
    ping,
    sync,
    getCalendarId,
    setCalendarId,
  };
})(typeof window !== 'undefined' ? window : this);
