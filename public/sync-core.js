// Bidirektionaler Sync-Algorithmus zwischen einem lokalen Task-Speicher und einem Google-Kalender.
// Portabel (Node für Tests, Browser für die eigenständigen Geräte-Installationen): arbeitet nur gegen
// die Schnittstellen `store` und `remote`, nie direkt gegen eine Datenbank oder `fetch`.
//
// store (austauschbar: IndexedDB im Browser, In-Memory in Tests):
//   getRawTasks()            -> Promise<Task[]>         alle Tasks, inkl. zum Löschen markierter
//   saveRawTasks(tasks)      -> Promise<void>            kompletter Ersatz
//   getMeta(key)             -> Promise<string|null>
//   setMeta(key, value)      -> Promise<void>
//   getConfig()              -> Promise<{categories, locations}|null>
//   saveConfig(cfg)          -> Promise<void>
//   getOutbox()              -> Promise<OutboxEntry[]>   nach `seq` aufsteigend
//   removeOutboxEntry(seq)   -> Promise<void>
//
// remote (austauschbar: echtes Google-Kalender-REST-API im Browser, Attrappe in Tests):
//   listChanges(syncToken)    -> Promise<{events, nextSyncToken, incremental}>
//   get(id)                   -> Promise<event>            wirft bei 404/410, wenn das Event weg ist
//   insert(body)              -> Promise<event>
//   patch(id, body)           -> Promise<event>
//   remove(id)                -> Promise<void>
//   readConfig()              -> Promise<{id, updated, categories, locations}|null>
//   writeConfig(id|null, cfg) -> Promise<{id, updated}>
//
// Task-Schema: siehe offline-logic.js. Jeder Task hat eine feste, lokal erzeugte `id`, die sich nie
// ändert (kein Remapping nötig, anders als bei einer zentralen Datenbank mit Auto-Increment-IDs).
// `google_event_id` verweist, sobald vorhanden, auf das zugehörige Kalender-Event.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./offline-logic'), require('./recurrence'));
  else root.SyncCore = factory(root.OfflineLogic, root.Recurrence);
})(typeof self !== 'undefined' ? self : this, function (L, Recurrence) {
  const DONE_PREFIX = '✓ ';
  const DONE_COLOR = '8'; // Graphit, reserviert für „erledigt“
  const DONE_RE = /^✓\s*/;
  const CONFIG_MARKER = 'haus-tasks-config'; // erkennt das versteckte Einstellungs-Event auf dem Kalender

  // Zuständigkeit steht zusätzlich sichtbar als Kürzel hinter dem Titel im Kalender (Wunsch: auf einen
  // Blick erkennbar, auch in Googles eigener App). extendedProperties.private.assignee bleibt trotzdem
  // die verlässliche Quelle; das Kürzel im Titel ist nur die Anzeige.
  const ASSIGNEE_INITIAL = { Caro: 'C', Hannes: 'H' };
  const INITIAL_TO_ASSIGNEE = { C: 'Caro', H: 'Hannes' };
  const ASSIGNEE_SUFFIX_RE = /\s*\(([CH])\)\s*$/;

  const nowIso = () => new Date().toISOString();
  const httpStatus = (e) => e.status ?? e.response?.status ?? (Number.isInteger(Number(e.code)) ? Number(e.code) : undefined);
  const isGone = (e) => [404, 410].includes(httpStatus(e));

  function eventBody(t) {
    // Titel, Datum und Farbe bleiben für jeden normalen Kalender lesbar; alles Weitere (Kategorie, Ort,
    // Priorität, Notizen, Checkliste, Serie) steckt versteckt in extendedProperties.private – dadurch
    // sieht Google Kalender selbst nur einen normalen Termin, aber jede Haus-Tasks-Installation kann die
    // Zusatzinfos wieder auslesen. „private“ heißt hier: nur für diese App sichtbar, nicht personenbezogen.
    const initial = t.assignee && ASSIGNEE_INITIAL[t.assignee];
    return {
      summary: (t.done ? DONE_PREFIX : '') + t.title + (initial ? ` (${initial})` : ''),
      start: { date: t.due_date },
      end: { date: Recurrence.addDays(t.due_date, 1) }, // Ende ganztägiger Events ist exklusiv
      colorId: t.done ? DONE_COLOR : t.color,
      transparency: 'transparent', // blockiert die Verfügbarkeit nicht
      extendedProperties: {
        private: {
          category: t.category || '',
          location: t.location || '',
          assignee: t.assignee || '',
          priority: t.priority || 'mittel',
          notes: t.notes || '',
          checklist: JSON.stringify(t.checklist || []),
          recurrence: t.recurrence ? JSON.stringify(t.recurrence) : '',
          series_id: t.series_id || '',
          color: t.color || '', // die „echte“ Farbe, damit sie nach einem Erledigt/Grau-Zyklus wiederhergestellt werden kann
        },
      },
    };
  }

  // Baut aus einem rohen Google-Event wieder ein vollständiges, task-förmiges Objekt zusammen (Titel,
  // Datum, erledigt, Farbe, plus die versteckten Zusatzfelder). Fehlt extendedProperties (z. B. ein
  // Termin, den jemand direkt in Google angelegt hat), gelten einfach nur die sichtbaren Grundfelder.
  // Wird sowohl beim Einlesen neuer Fremd-Events als auch beim konfliktsicheren Zusammenführen vor
  // einem Patch verwendet (siehe push()).
  function taskShapeFromEvent(ev) {
    const summary = ev.summary || '(ohne Titel)';
    const done = DONE_RE.test(summary);
    let title = summary.replace(DONE_RE, '') || '(ohne Titel)';
    const p = ev.extendedProperties?.private || {};
    // Kürzel aus dem sichtbaren Titel lösen – auch wenn jemand direkt in Google „Task (H)“ getippt hat,
    // nicht nur wenn diese App es selbst angehängt hatte. extendedProperties.assignee hat trotzdem Vorrang.
    const suffixMatch = title.match(ASSIGNEE_SUFFIX_RE);
    if (suffixMatch) title = title.slice(0, suffixMatch.index).trim() || '(ohne Titel)';
    const assignee = p.assignee || (suffixMatch ? INITIAL_TO_ASSIGNEE[suffixMatch[1]] : null) || null;
    let checklist = [];
    let recurrence = null;
    try { checklist = p.checklist ? JSON.parse(p.checklist) : []; } catch { /* fremder/kaputter Wert: ignorieren */ }
    try { recurrence = p.recurrence ? JSON.parse(p.recurrence) : null; } catch { /* dito */ }
    const color = (!done && p.color) || (ev.colorId && ev.colorId !== DONE_COLOR ? ev.colorId : null) || p.color || '9';
    return {
      title, due_date: ev.start?.date || null, done, color,
      category: p.category || null, location: p.location || null, assignee, priority: p.priority || 'mittel',
      notes: p.notes || '', checklist, recurrence, series_id: p.series_id || null,
    };
  }

  function findByEvent(tasks, eventId) {
    return tasks.find((t) => t.google_event_id === eventId);
  }

  // Gibt { tasks, changed } zurück; `changed` zeigt an, ob sich lokal etwas geändert hat.
  function applyRemoteEvent(tasks, ev) {
    const row = findByEvent(tasks, ev.id);

    // Der versteckte Kategorien/Orte-Termin (siehe syncConfig) ist kein Task und soll nie als einer
    // auftauchen. Existiert lokal schon eine fälschlich importierte Zeile dafür (ältere Version dieser
    // App), wird nur die lokale Zeile entfernt – der echte Kalendertermin bleibt unangetastet, er trägt
    // ja die gemeinsame Konfiguration.
    if (ev.extendedProperties?.private?.appMarker === CONFIG_MARKER) {
      if (!row) return { tasks, changed: false };
      return { tasks: tasks.filter((t) => t.id !== row.id), changed: true };
    }

    if (ev.status === 'cancelled') {
      if (!row) return { tasks, changed: false };
      return { tasks: tasks.filter((t) => t.id !== row.id), changed: true };
    }
    if (!ev.start?.date || ev.recurrence) return { tasks, changed: false }; // nur einzelne ganztägige Events

    const shape = taskShapeFromEvent(ev);

    if (!row) {
      const ts = ev.updated || nowIso();
      const task = {
        id: L.newId(), ...shape, done_at: shape.done ? ts : null, next_task_id: null,
        google_event_id: ev.id, google_updated: ev.updated || null,
        deleted: false, created_at: ts, updated_at: ts,
      };
      return { tasks: [...tasks, task], changed: true };
    }
    if (row.deleted) return { tasks, changed: false }; // Löschung steht noch aus
    if (ev.updated && ev.updated === row.google_updated) return { tasks, changed: false }; // Echo der eigenen Änderung

    // „Erledigt“ wird hier bewusst nur übernommen, nicht über setDone() gesetzt: Bei einer Serie legt
    // setDone() zusätzlich den Folgetermin an, und das darf ausschließlich das Gerät tun, auf dem
    // tatsächlich abgehakt wurde – sonst würde jedes andere Gerät beim nächsten Sync denselben
    // Folgetermin ein zweites Mal (mit einer eigenen ID) erzeugen. Alle anderen Geräte bekommen den
    // schon vom ursprünglichen Gerät angelegten Folgetermin ohnehin gleich als ganz normalen neuen
    // Termin über den `!row`-Zweig oben mitgeliefert.
    const updated = {
      ...row, ...shape,
      done_at: shape.done !== !!row.done ? (shape.done ? (ev.updated || nowIso()) : null) : row.done_at,
      google_updated: ev.updated || null, updated_at: ev.updated || nowIso(),
    };
    return { tasks: tasks.map((t) => (t.id === row.id ? updated : t)), changed: true };
  }

  // Holt Änderungen vom Kalender und spiegelt sie in den lokalen Speicher. `dirtyIds` (Tasks mit
  // wartenden Warteschlangen-Einträgen) verhindert, dass eine gerade erst lokal gemachte, noch nicht
  // gesendete Änderung von einer älteren Server-Version überschrieben wird.
  async function pull(store, remote, dirtyIds) {
    const token = await store.getMeta('sync_token');
    let res;
    try {
      res = await remote.listChanges(token);
    } catch (e) {
      if (!token || !isGone(e)) throw e;
      await store.setMeta('sync_token', null); // Token abgelaufen: komplett neu abgleichen
      res = await remote.listChanges(null);
    }
    let tasks = await store.getRawTasks();
    const full = !res.incremental;
    const seen = new Set();
    let pulled = 0;

    for (const ev of res.events) {
      if (ev.status !== 'cancelled') seen.add(ev.id);
      const row = findByEvent(tasks, ev.id);
      if (row && dirtyIds.has(row.id) && ev.updated && row.updated_at > ev.updated) continue; // lokal jünger, wird gleich gepusht
      const r = applyRemoteEvent(tasks, ev);
      if (r.changed) { tasks = r.tasks; pulled++; }
    }

    if (full) {
      // Was lokal ein Google-Event hat, dort aber nicht mehr vorkommt, wurde in Google gelöscht.
      for (const row of tasks.filter((t) => t.google_event_id && !t.deleted)) {
        if (seen.has(row.google_event_id)) continue;
        if (dirtyIds.has(row.id)) {
          tasks = tasks.map((t) => (t.id === row.id ? { ...t, google_event_id: null, google_updated: null } : t)); // lokale Änderung gewinnt
        } else {
          tasks = tasks.filter((t) => t.id !== row.id);
          pulled++;
        }
      }
    }
    await store.saveRawTasks(tasks);
    if (res.nextSyncToken) await store.setMeta('sync_token', res.nextSyncToken);
    return pulled;
  }

  // Prüft vor dem Senden, ob sich ein Task auf dem Server (ein anderes Gerät, eine direkte Google-
  // Bearbeitung) inzwischen weiterbewegt hat, seit die lokale Änderung gemacht wurde. Verhindert nichts,
  // liefert nur die Info für einen Hinweis an die Nutzerin/den Nutzer – dank Teil-Patches verträgt sich
  // das ohnehin meist von selbst.
  function detectClash(entry, task, freshEvent) {
    if (!entry.baseUpdatedAt || !freshEvent) return null;
    return freshEvent.updated !== entry.baseUpdatedAt ? { title: task?.title || '(gelöscht)', op: entry.op } : null;
  }

  // Sendet die Warteschlange der Reihe nach an Google. Da jede Task-ID von Anfang an fest ist (siehe
  // offline-logic.js), ist – anders als bei einer zentralen Datenbank mit Auto-Increment – keine
  // ID-Umschreibung nötig: ein Task, der eben erst sein erstes google_event_id bekommen hat, wird beim
  // nächsten Eintrag in derselben Warteschlange einfach erneut aus dem Speicher gelesen.
  async function push(store, remote) {
    const entries = await store.getOutbox();
    const sent = [];
    const failed = [];
    const clashes = [];

    for (const entry of entries) {
      let tasks = await store.getRawTasks();
      const task = tasks.find((t) => t.id === entry.taskId);
      if (!task) {
        await store.removeOutboxEntry(entry.seq); // lokal inzwischen ganz verschwunden (z. B. Kategorie-Kaskade dieses Geräts)
        continue;
      }

      try {
        // Ein Löschauftrag existiert nur für Tasks, die schon ein Google-Event hatten (offline-logic.js
        // entfernt einen nie synchronisierten Task sofort lokal, ganz ohne Warteschlangen-Eintrag).
        if (entry.op === 'delete') {
          const freshEvent = entry.baseUpdatedAt ? await remote.get(task.google_event_id).catch(() => null) : null;
          const clash = detectClash(entry, task, freshEvent);
          if (clash) clashes.push(clash);
          await remote.remove(task.google_event_id).catch((e) => { if (!isGone(e)) throw e; });
          await store.saveRawTasks((await store.getRawTasks()).filter((t) => t.id !== entry.taskId));
          sent.push(entry);
          await store.removeOutboxEntry(entry.seq);
          continue;
        }

        if (!task.due_date) {
          // Ohne Datum gehört der Task nur in die App; ein evtl. vorhandenes Event wird entfernt.
          if (task.google_event_id) await remote.remove(task.google_event_id).catch((e) => { if (!isGone(e)) throw e; });
          tasks = tasks.map((t) => (t.id === task.id ? { ...t, google_event_id: null, google_updated: null } : t));
          await store.saveRawTasks(tasks);
          sent.push(entry);
          await store.removeOutboxEntry(entry.seq);
          continue;
        }

        // Kein Event vorhanden (erste Anlage): einfach mit dem vollen lokalen Stand anlegen, es gibt
        // noch nichts, womit man ihn zusammenführen müsste.
        if (!task.google_event_id) {
          const ev = await remote.insert(eventBody(task));
          tasks = tasks.map((t) => (t.id === task.id ? { ...t, google_event_id: ev.id, google_updated: ev.updated } : t));
          await store.saveRawTasks(tasks);
          sent.push(entry);
          await store.removeOutboxEntry(entry.seq);
          continue;
        }

        // Update/Erledigt auf einem bereits bekannten Event: erst den aktuellen Google-Stand holen und
        // NUR das in diesem Eintrag tatsächlich geänderte Feld darüberlegen, dann erst senden. Google
        // ersetzt die versteckten Zusatzfelder bei einem Patch sonst komplett (siehe Kommentar oben an
        // eventBody) – ohne diesen Zwischenschritt würde ein Update von Gerät A ein zeitgleiches Update
        // von Gerät B an einem anderen Feld überschreiben.
        let freshEvent;
        try {
          freshEvent = await remote.get(task.google_event_id);
        } catch (e) {
          if (!isGone(e)) throw e;
          freshEvent = null; // Event wurde in Google gelöscht
        }

        if (!freshEvent) {
          const ev = await remote.insert(eventBody(task)); // neu anlegen, mit dem vollen lokalen Stand
          tasks = tasks.map((t) => (t.id === task.id ? { ...t, google_event_id: ev.id, google_updated: ev.updated } : t));
          await store.saveRawTasks(tasks);
          sent.push(entry);
          await store.removeOutboxEntry(entry.seq);
          continue;
        }

        const clash = detectClash(entry, task, freshEvent);
        if (clash) clashes.push(clash);

        const merged = { ...taskShapeFromEvent(freshEvent), ...entry.patch };
        const ev = await remote.patch(task.google_event_id, eventBody(merged));
        tasks = tasks.map((t) => (t.id === task.id ? { ...t, ...merged, google_event_id: ev.id, google_updated: ev.updated } : t));
        await store.saveRawTasks(tasks);
        sent.push(entry);
        await store.removeOutboxEntry(entry.seq);
      } catch (e) {
        if (httpStatus(e) >= 400 && httpStatus(e) < 500) {
          // Dauerhaft ungültig – verwerfen statt die Warteschlange zu blockieren.
          failed.push({ entry, error: e.message });
          await store.removeOutboxEntry(entry.seq);
          continue;
        }
        return { sent, failed, clashes, aborted: true }; // Netzwerkfehler: Rest bleibt gespeichert
      }
    }
    return { sent, failed, clashes, aborted: false };
  }

  // Kategorien/Orte liegen als kleiner, versteckter Termin auf dem geteilten Kalender, damit sie ohne
  // eigenen Server zwischen allen Installationen mitwandern. Änderungen sind selten, „neuer gewinnt“
  // reicht hier als Konfliktregel völlig aus.
  async function syncConfig(store, remote) {
    const local = await store.getConfig();
    const remoteCfg = await remote.readConfig();
    if (!remoteCfg && local) {
      await remote.writeConfig(null, local);
      return;
    }
    if (!remoteCfg) return;
    const localNewer = local?.updated_at && remoteCfg.updated && local.updated_at > remoteCfg.updated;
    if (localNewer) {
      await remote.writeConfig(remoteCfg.id, local);
    } else {
      await store.saveConfig({ categories: remoteCfg.categories, locations: remoteCfg.locations, updated_at: remoteCfg.updated });
    }
  }

  async function syncWith(store, remote) {
    const outboxBefore = await store.getOutbox();
    const dirtyIds = new Set(outboxBefore.map((e) => e.taskId));
    const pulled = await pull(store, remote, dirtyIds);
    const { sent, failed, clashes, aborted } = await push(store, remote);
    await syncConfig(store, remote).catch(() => {}); // Konfiguration ist nice-to-have, darf den Task-Sync nicht blockieren
    return { pulled, pushed: sent.length, failed, clashes, aborted };
  }

  return { syncWith, pull, push, syncConfig, eventBody, taskShapeFromEvent, CONFIG_MARKER, DONE_PREFIX, DONE_COLOR };
});
