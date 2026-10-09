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

  // Tasks ohne Datum bekommen trotzdem ein (verstecktes, auf 1970 gelegtes) Event, sonst würden sie nie
  // zu Google übertragen und wären auf das eine Gerät beschränkt, auf dem sie angelegt wurden – bei
  // mehreren unabhängigen Geräte-Installationen ist Google der einzige gemeinsame Speicherort.
  const NO_DATE_PLACEHOLDER = '1970-01-01';

  // Für Tasks mit Uhrzeit (siehe eventBody()): die Zeitzone des Geräts, auf dem gerade gesynct wird – damit
  // ist das Gerät maßgeblich, nicht ein im Code festgelegter Ort, falls Haus-Tasks mal anderswo läuft.
  const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Zuständigkeit steht zusätzlich sichtbar als Kürzel hinter dem Titel im Kalender (Wunsch: auf einen
  // Blick erkennbar, auch in Googles eigener App). extendedProperties.private.assignee bleibt trotzdem
  // die verlässliche Quelle; das Kürzel im Titel ist nur die Anzeige.
  const ASSIGNEE_INITIAL = { Caro: 'C', Hannes: 'H' };
  const INITIAL_TO_ASSIGNEE = { C: 'Caro', H: 'Hannes' };
  const ASSIGNEE_SUFFIX_RE = /\s*\(([CH])\)\s*$/;

  const nowIso = () => new Date().toISOString();
  const httpStatus = (e) => e.status ?? e.response?.status ?? (Number.isInteger(Number(e.code)) ? Number(e.code) : undefined);
  const isGone = (e) => [404, 410].includes(httpStatus(e));

  // Gemeinsame Einstellungen (liegen zusammen mit Kategorien/Orten im versteckten Konfigurations-Event, gelten
  // also für alle Geräte). Fehlt ein Wert, gilt die Vorgabe hier.
  //   untimedAtEndOfDay: Tasks mit Datum, aber ohne Uhrzeit, werden im Google-Kalender nicht als Ganztags-
  //   termin, sondern als kurzer Termin am Tagesende angelegt. Ganztagstermine stehen in Googles Monats-/
  //   Wochen-/Tagesansicht über allen Terminen mit Uhrzeit und schieben normale Termine nach unten, sobald
  //   viele Tasks an einem Tag liegen; am Tagesende sortiert, stören sie nicht mehr.
  //   Damit die Titel in der Tagesansicht lesbar bleiben (kürzer als ~25 Minuten wird nur ein Strich
  //   gezeichnet, Termine mit gleicher Startzeit stehen nebeneinander), bekommt jeder Task einen Platz:
  //   25 Minuten lang, je 3 Tasks nebeneinander im selben Platz, 4 Plätze von hinten gezählt
  //   (Platz 0 = 23:34–23:59, 1 = 23:09–23:34, 2 = 22:44–23:09, 3 = 22:19–22:44). Das reicht für 12 Tasks pro
  //   Tag; weitere teilen sich die am wenigsten belegten Plätze (dann eben schmalere Spalten).
  // lists: die Listen (Tasks, Einkauf, …) mit Name und Farbe; „tasks“ ist die Hauptliste und gibt es immer.
  const MAIN_LIST = 'tasks';
  const DEFAULT_LISTS = [{ id: MAIN_LIST, name: 'Tasks', color: '9' }];
  const DEFAULT_SETTINGS = { untimedAtEndOfDay: true, lists: DEFAULT_LISTS };
  const SLOT_COUNT = 4;
  const SLOT_PER_ROW = 3;
  const SLOT_MINUTES = 25;
  const SLOT_LAST_END = 23 * 60 + 59; // 23:59, ein Event darf nicht über Mitternacht gehen
  const pad2 = (n) => String(n).padStart(2, '0');
  const hhmm = (mins) => `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;
  function slotTimes(index) {
    const end = SLOT_LAST_END - index * SLOT_MINUTES;
    return { start: hhmm(end - SLOT_MINUTES), end: hhmm(end) };
  }
  // Wie viele Tasks pro Sync auf die neue Darstellung umgestellt werden (2 Google-Aufrufe je Task). Der Rest
  // folgt automatisch beim nächsten Sync, so blockiert die einmalige Umstellung vieler Alt-Tasks nicht lange.
  const SLOT_RECONCILE_LIMIT = 40;

  // „Unsichtbarer Sync“: Nur Tasks mit Häkchen „In Google Kalender anzeigen“ (`in_calendar`) erscheinen im
  // Kalender an ihrem echten Datum. Alle anderen liegen als versteckter, privater Ganztagstermin an einem
  // weit zurückliegenden Tag (1971–1980) – dort stört er niemanden, wird aber trotzdem zwischen allen Geräten
  // synchronisiert. Das echte Datum (und die Uhrzeit) steht dann in versteckten Zusatzfeldern. Der Tag wird aus
  // der Task-ID abgeleitet und über ~10 Jahre gestreut, damit nicht Hunderte Termine an einem einzigen Tag
  // hängen (Google veröffentlicht zwar kein festes Tageslimit, aber so ist man auf der sicheren Seite).
  // Einmal vergeben, bleibt der Tag stehen (`hidden_date`, wird aus dem Event gelesen), egal welches Gerät
  // später schreibt – die Task-ID selbst kennen andere Geräte nämlich nicht (siehe applyRemoteEvent).
  const HIDDEN_EPOCH = '1971-01-01';
  const HIDDEN_DAYS = 3650;
  const CAL_RECONCILE_LIMIT = 30; // wie SLOT_RECONCILE_LIMIT: Umstellung bestehender Tasks häppchenweise
  const isHiddenDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= HIDDEN_EPOCH && d < '1982-01-01';
  function hiddenDateFor(t) {
    if (isHiddenDate(t.hidden_date)) return t.hidden_date;
    let hash = 0;
    for (const ch of String(t.id || t.title || '')) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return Recurrence.addDays(HIDDEN_EPOCH, hash % HIDDEN_DAYS);
  }
  // Steht der Task sichtbar im Kalender? Ohne Datum gibt es nichts anzuzeigen.
  // Tasks aus einer Version ohne Schalter (in_calendar fehlt ganz) gelten wie beim Einlesen: nur mit Uhrzeit sichtbar.
  const isVisible = (t) => !!(t.due_date && (t.in_calendar === undefined ? t.due_time : t.in_calendar));

  function resolveSettings(raw) {
    const s = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
    let lists = Array.isArray(s.lists) ? s.lists.filter((l) => l && typeof l.id === 'string' && l.id && typeof l.name === 'string') : [];
    if (!lists.some((l) => l.id === MAIN_LIST)) lists = [...DEFAULT_LISTS, ...lists]; // Hauptliste fehlt nie, auch wenn ein Gerät sie versehentlich verliert
    return { ...s, lists };
  }

  // Bekommt der Task im Kalender einen Platz am Tagesende? Nur bei sichtbaren Tasks mit echtem Datum und ohne
  // eigene Uhrzeit (alles Versteckte liegt ganztägig auf einem alten Tag).
  function usesTimeSlot(t, opts) {
    return !!(opts && opts.untimedAtEndOfDay && isVisible(t) && !t.due_time);
  }

  // Legt (falls noch keiner da ist) den Platz fest: der erste Platz mit weniger als SLOT_PER_ROW Tasks an diesem
  // Tag, sonst der am wenigsten belegte. Ein einmal vergebener Platz bleibt stehen – auch wenn andere Tasks
  // erledigt, gelöscht oder verschoben werden –, damit sich Termine im Kalender nicht ständig verschieben und
  // nicht bei jeder Änderung Folge-Patches nötig sind. Erledigte Tasks behalten ihren Platz ebenfalls, damit ein
  // „Rückgängig“ keinen vierten Task in dieselbe Reihe zwingt. `tasks` ist der lokale Stand (inkl. dem, was
  // andere Geräte schon vergeben haben); gleichzeitige Vergabe auf zwei Geräten kann zu einer Reihe mit 4 Tasks
  // führen – harmlos, nur etwas schmaler.
  function withSlotIndex(tasks, t, opts) {
    if (!usesTimeSlot(t, opts)) return { ...t, slot_index: null };
    if (Number.isInteger(t.slot_index) && t.slot_index >= 0 && t.slot_index < SLOT_COUNT) return t;
    const counts = new Array(SLOT_COUNT).fill(0);
    for (const o of tasks) {
      if (o.id === t.id || o.deleted || !o.time_slot || o.due_date !== t.due_date) continue;
      if (Number.isInteger(o.slot_index) && o.slot_index >= 0 && o.slot_index < SLOT_COUNT) counts[o.slot_index]++;
    }
    let index = counts.findIndex((c) => c < SLOT_PER_ROW);
    if (index < 0) index = counts.indexOf(Math.min(...counts));
    return { ...t, slot_index: index };
  }

  function eventBody(t, opts = {}) {
    // Titel, Datum und Farbe bleiben für jeden normalen Kalender lesbar; alles Weitere (Kategorie, Ort,
    // Priorität, Notizen, Checkliste, Serie) steckt versteckt in extendedProperties.private – dadurch
    // sieht Google Kalender selbst nur einen normalen Termin, aber jede Haus-Tasks-Installation kann die
    // Zusatzinfos wieder auslesen. „private“ heißt hier: nur für diese App sichtbar, nicht personenbezogen.
    const initial = t.assignee && ASSIGNEE_INITIAL[t.assignee];
    const visible = isVisible(t);
    const due = visible ? t.due_date : hiddenDateFor(t);
    // Beim Wechsel zwischen "ganztägig" (date) und "mit Uhrzeit" (dateTime) muss die jeweils andere
    // Darstellung explizit auf null gesetzt werden, nicht nur weggelassen: Google lässt sie sonst von
    // einer vorherigen Version des Termins stehen und lehnt die dann widersprüchliche Kombination ab
    // ("Invalid start time"). Ohne eigene Endzeit gilt eine Stunde Dauer als Vorgabe.
    const hasTime = visible && !!t.due_time;
    const slot = usesTimeSlot(t, opts);
    const tz = opts.timeZone || TIME_ZONE;
    let start, end;
    if (hasTime) {
      const endAt = t.due_end_time ? { date: t.due_date, time: t.due_end_time } : Recurrence.addMinutes(t.due_date, t.due_time, 60);
      start = { date: null, dateTime: `${t.due_date}T${t.due_time}:00`, timeZone: TIME_ZONE };
      end = { date: null, dateTime: `${endAt.date}T${endAt.time}:00`, timeZone: TIME_ZONE };
    } else if (slot) {
      // Zeitzone des Kalenders (nicht des Geräts): sonst rutscht der Task von einem Gerät in einer anderen
      // Zeitzone auf den Folgetag, weil die Platzzeiten dort woanders liegen.
      const times = slotTimes(Number.isInteger(t.slot_index) && t.slot_index >= 0 && t.slot_index < SLOT_COUNT ? t.slot_index : 0);
      start = { date: null, dateTime: `${t.due_date}T${times.start}:00`, timeZone: tz };
      end = { date: null, dateTime: `${t.due_date}T${times.end}:00`, timeZone: tz };
    } else {
      start = { date: due, dateTime: null, timeZone: null };
      end = { date: Recurrence.addDays(due, 1), dateTime: null, timeZone: null }; // Ende ganztägiger Events ist exklusiv
    }
    const body = {
      summary: (t.done ? DONE_PREFIX : '') + t.title + (initial ? ` (${initial})` : ''),
      start, end,
      colorId: t.done ? DONE_COLOR : t.color,
      transparency: 'transparent', // blockiert die Verfügbarkeit nicht
      visibility: visible ? 'default' : 'private', // versteckter Termin möglichst unauffällig
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
          noDate: '', // veraltet (früher: Platzhalter 1970 für datumslose Tasks), ersetzt durch cal/due
          cal: visible ? 'show' : 'hide', // „show“ = Termin liegt am echten Datum, „hide“ = versteckt auf einem alten Tag
          due: visible ? '' : (t.due_date || ''), // echtes Datum, solange der Termin versteckt ist
          dueTime: !visible && t.due_date && t.due_time ? t.due_time : '',
          dueEnd: !visible && t.due_date && t.due_time && t.due_end_time ? t.due_end_time : '',
          noTime: slot ? 'true' : '', // Platz am Tagesende statt echter Uhrzeit (siehe usesTimeSlot)
          slot: slot && Number.isInteger(t.slot_index) ? String(t.slot_index) : '', // welcher Platz (siehe withSlotIndex)
          bucket: t.bucket || '', // GTD-Status (inbox/todo/later), siehe offline-logic.js
          list: t.list_id || MAIN_LIST, // Liste (siehe resolveSettings)
          order: Number.isFinite(t.order) ? String(t.order) : '', // Position bei manueller Sortierung
        },
      },
    };
    // Ein Termin mit Uhrzeit bekäme sonst die Standard-Benachrichtigung des Kalenders (also um ~23:30 für jeden
    // Task) – für den Platzhalter ausdrücklich abschalten. Beim Zurückstellen auf ganztägig wieder auf die
    // Standardeinstellung des Kalenders setzen; sonst (kein Wechsel) bleibt `reminders` unangetastet.
    if (slot || !visible) body.reminders = { useDefault: false, overrides: [] };
    else body.reminders = { useDefault: true };
    return body;
  }

  // Baut aus einem rohen Google-Event wieder ein vollständiges, task-förmiges Objekt zusammen (Titel,
  // Datum, erledigt, Farbe, plus die versteckten Zusatzfelder). Fehlt extendedProperties (z. B. ein
  // Termin, den jemand direkt in Google angelegt hat), gelten einfach nur die sichtbaren Grundfelder.
  // Wird sowohl beim Einlesen neuer Fremd-Events als auch beim konfliktsicheren Zusammenführen vor
  // einem Patch verwendet (siehe push()).
  const parseOrder = (v) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

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
    // ev.start.date fehlt, wenn der Termin eine Uhrzeit hat (start.dateTime statt start.date) – entweder
    // bewusst (Task mit Uhrzeit, siehe eventBody()) oder weil jemand direkt in Google eine Uhrzeit
    // draufgesetzt hat. Der Datumsanteil ist so oder so brauchbar, einfach daraus nehmen – ohne diesen
    // Rückfall würde ein Merge das Datum sonst auf den Platzhalter zurücksetzen, nicht nur den Patch ablehnen.
    const startDate = ev.start?.date || (ev.start?.dateTime ? ev.start.dateTime.slice(0, 10) : null);
    const own = 'priority' in p;
    // Versteckter Termin (siehe HIDDEN_EPOCH): echtes Datum/Uhrzeit stehen in den Zusatzfeldern, der Termin selbst
    // liegt auf einem alten Tag, den wir uns merken, damit er beim nächsten Schreiben nicht umzieht.
    if (p.cal === 'hide') {
      const due_date = p.due && !isHiddenDate(p.due) ? p.due : null; // siehe unten: kaputte Altdaten (Datum 1971–1981) verwerfen
      const due_time = due_date && p.dueTime ? p.dueTime : null;
      return {
        title, due_date, due_time, due_end_time: due_time && p.dueEnd ? p.dueEnd : null,
        time_slot: false, slot_index: null, done, color,
        category: p.category || null, location: p.location || null, assignee, priority: p.priority || 'mittel',
        notes: p.notes || '', checklist, recurrence, series_id: p.series_id || null,
        bucket: ['inbox', 'todo', 'later'].includes(p.bucket) ? p.bucket : 'todo', list_id: p.list || MAIN_LIST, order: parseOrder(p.order),
        in_calendar: false, cal_migrate: false, hidden_date: isHiddenDate(startDate) ? startDate : null,
      };
    }
    // Ein Datum aus dem Bereich der versteckten Termine (1971–1981) ist nie ein echtes Fälligkeitsdatum, sondern
    // stammt von einer älteren App-Version, die den versteckten Tag als Datum gelesen und zurückgeschrieben hat.
    const due_date = p.noDate === 'true' || isHiddenDate(startDate) ? null : (startDate || null);
    // Ein Platz am Tagesende (siehe usesTimeSlot) zählt als „keine Uhrzeit“. Der Marker allein reicht nicht – ohne
    // dateTime (z. B. wieder auf ganztägig gestellt) ist der Termin kein Platzhalter mehr. Ältere Termine
    // dieser Art (23:58–23:59, noch ohne Platznummer) bekommen slot_index null und werden beim Abgleich umgestellt.
    const time_slot = p.noTime === 'true' && !!ev.start?.dateTime;
    const slot_index = time_slot && /^\d+$/.test(p.slot || '') ? Number(p.slot) : null;
    const due_time = due_date && ev.start?.dateTime && !time_slot ? ev.start.dateTime.slice(11, 16) : null;
    // Nur übernehmen, wenn die Endzeit auf denselben Tag fällt – ein über Mitternacht gehender Termin
    // wird (wie beim Anlegen, siehe eventBody()) nicht unterstützt, dann lieber die Vorgabe (eine Stunde).
    const due_end_time = due_time && ev.end?.dateTime && ev.end.dateTime.slice(0, 10) === due_date ? ev.end.dateTime.slice(11, 16) : null;
    // Sichtbar im Kalender: mit Marker „show“ sicher; ohne Marker (Termin aus einer Version vor dem Schalter oder
    // direkt in Google angelegt) gilt: eigene Tasks nur mit echter Uhrzeit, fremde Termine immer. Eigene
    // Alt-Termine, die nach dieser Regel unsichtbar werden sollen, bekommen `cal_migrate` und werden beim
    // nächsten Sync (reconcileCalendar) auf einen alten Tag verschoben.
    const in_calendar = !!due_date && (p.cal === 'show' ? true : own ? !!due_time : true);
    return {
      title, due_date, due_time, due_end_time, time_slot, slot_index, done, color,
      category: p.category || null, location: p.location || null, assignee, priority: p.priority || 'mittel',
      notes: p.notes || '', checklist, recurrence, series_id: p.series_id || null,
      bucket: ['inbox', 'todo', 'later'].includes(p.bucket) ? p.bucket : 'todo', list_id: p.list || MAIN_LIST, order: parseOrder(p.order),
      in_calendar, cal_migrate: own && p.cal !== 'show' && !in_calendar, hidden_date: null,
    };
  }

  // Lokale Zusatzfelder, nachdem ein Event mit diesem Stand geschrieben wurde.
  function writtenFields(t, opts) {
    return { time_slot: usesTimeSlot(t, opts), slot_index: t.slot_index ?? null, in_calendar: isVisible(t), cal_migrate: false, hidden_date: isVisible(t) ? null : hiddenDateFor(t) };
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
    // Ein fremder Termin mit Uhrzeit (jemand hat ihn direkt in Google angelegt) wird nicht als Task
    // übernommen. Ein eigener Haus-Tasks-Termin MIT Uhrzeit (erkennbar an extendedProperties.private,
    // die jeder App-eigene Termin hat – egal ob bewusst mit Uhrzeit angelegt oder nachträglich durch eine
    // direkte Google-Bearbeitung dorthin „verrutscht“) wird dagegen ganz normal übernommen/aktualisiert.
    const isOwnEvent = !!ev.extendedProperties?.private && 'priority' in ev.extendedProperties.private;
    if (!ev.start?.date && !isOwnEvent) return { tasks, changed: false };
    if (ev.recurrence) return { tasks, changed: false }; // wiederkehrende Google-Events bleiben ignoriert

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
  async function push(store, remote, opts = {}) {
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

        // Kein Event vorhanden (erste Anlage): einfach mit dem vollen lokalen Stand anlegen, es gibt
        // noch nichts, womit man ihn zusammenführen müsste.
        if (!task.google_event_id) {
          const slotted = withSlotIndex(tasks, { ...task, slot_index: null }, opts);
          const ev = await remote.insert(eventBody(slotted, opts));
          tasks = tasks.map((t) => (t.id === task.id ? { ...t, google_event_id: ev.id, google_updated: ev.updated, ...writtenFields(slotted, opts) } : t));
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
          const slotted = withSlotIndex(tasks, { ...task, slot_index: null }, opts);
          const ev = await remote.insert(eventBody(slotted, opts)); // neu anlegen, mit dem vollen lokalen Stand
          tasks = tasks.map((t) => (t.id === task.id ? { ...t, google_event_id: ev.id, google_updated: ev.updated, ...writtenFields(slotted, opts) } : t));
          await store.saveRawTasks(tasks);
          sent.push(entry);
          await store.removeOutboxEntry(entry.seq);
          continue;
        }

        const clash = detectClash(entry, task, freshEvent);
        if (clash) clashes.push(clash);

        const freshShape = taskShapeFromEvent(freshEvent);
        let merged = { ...freshShape, ...entry.patch };
        // Anderer Tag (oder Platz fehlt noch): Platz neu vergeben, am neuen Tag kann der alte schon voll sein.
        if (merged.due_date !== freshShape.due_date || !!merged.in_calendar !== !!freshShape.in_calendar) merged = { ...merged, slot_index: null };
        merged = withSlotIndex(tasks, { ...merged, id: task.id }, opts); // id bleibt dran: der versteckte Tag wird daraus abgeleitet
        const ev = await remote.patch(task.google_event_id, eventBody(merged, opts));
        tasks = tasks.map((t) => (t.id === task.id ? { ...t, ...merged, google_event_id: ev.id, google_updated: ev.updated, ...writtenFields(merged, opts) } : t));
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
        // Netzwerkfehler (oder ein unerwarteter Fehler ohne HTTP-Status): Rest bleibt gespeichert, versucht
        // es beim nächsten Sync erneut. abortReason nur für die Debug-Ansicht (#/debug) – zeigt sonst
        // unsichtbar genau denselben Eintrag immer wieder, ohne erkennbar zu machen, woran es liegt.
        return { sent, failed, clashes, aborted: true, abortReason: { entry, message: e.message, status: httpStatus(e) } };
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
      await store.saveConfig({ categories: remoteCfg.categories, locations: remoteCfg.locations, settings: remoteCfg.settings || {}, updated_at: remoteCfg.updated });
    }
  }

  // Stellt Tasks ohne Uhrzeit auf die gerade gewählte Darstellung um (23:58-Platzhalter oder ganztägig),
  // falls ihr Google-Event noch die andere hat – nötig für alle bestehenden Tasks, nachdem die Einstellung
  // zum ersten Mal greift oder umgeschaltet wurde, und für Tasks, die auf einem anderen Gerät neu dazukamen.
  // Läuft nach pull() und push(), also nie über eine noch nicht gesendete lokale Änderung drüber (deren
  // Tasks sind ausgenommen). Holt wie push() vor dem Patch den aktuellen Google-Stand, damit gleichzeitige
  // Änderungen an anderen Feldern erhalten bleiben. Fehler brechen den Sync nicht ab; was nicht klappt,
  // wird beim nächsten Sync erneut versucht.
  async function reconcileTimeSlots(store, remote, opts, dirtyIds) {
    let tasks = await store.getRawTasks();
    const enabled = !!opts.untimedAtEndOfDay;
    // Umzustellen sind Tasks, deren Event nicht zur Einstellung passt – und bei „an“ auch ältere Platzhalter ohne
    // Platznummer (23:58–23:59 aus einer früheren Version), die jetzt einen richtigen Platz bekommen.
    const candidates = tasks.filter((t) => t.google_event_id && !t.deleted && t.in_calendar && t.due_date && !t.due_time && !t.cal_migrate && !dirtyIds.has(t.id)
      && (!!t.time_slot !== enabled || (enabled && t.time_slot && !Number.isInteger(t.slot_index)))
      && t.slot_failed !== enabled);
    let updated = 0;
    for (const task of candidates.slice(0, SLOT_RECONCILE_LIMIT)) {
      try {
        const fresh = await remote.get(task.google_event_id);
        let merged = taskShapeFromEvent(fresh);
        if (merged.due_time || !merged.due_date || !merged.in_calendar) continue; // inzwischen ein Termin mit echter Uhrzeit bzw. ohne Datum: nichts umzustellen
        // `tasks` wird nach jedem Task fortgeschrieben, so sieht der nächste die schon vergebenen Plätze.
        merged = { ...withSlotIndex(tasks, { ...merged, id: task.id }, opts) };
        const ev = await remote.patch(task.google_event_id, eventBody(merged, opts));
        tasks = tasks.map((t) => (t.id === task.id ? { ...t, google_updated: ev.updated, ...writtenFields(merged, opts), slot_failed: undefined } : t));
        await store.saveRawTasks(tasks);
        updated++;
      } catch (e) {
        const status = httpStatus(e);
        if (isGone(e)) continue; // Event weg: der nächste Abgleich räumt das lokal auf
        if (status >= 400 && status < 500) {
          // Dauerhaft abgelehnt: für diese Einstellung nicht ständig neu versuchen (siehe slot_failed-Prüfung oben).
          tasks = tasks.map((t) => (t.id === task.id ? { ...t, slot_failed: !!opts.untimedAtEndOfDay } : t));
          await store.saveRawTasks(tasks);
          continue;
        }
        break; // Netzwerkproblem o. Ä.: Rest beim nächsten Sync
      }
    }
    return updated;
  }

  // Stellt Tasks, deren Google-Event noch die alte Darstellung hat (ohne Marker `cal`), auf den „unsichtbaren Sync“
  // um: Alt-Tasks ohne Uhrzeit wandern auf einen alten Tag, Tasks mit Uhrzeit bleiben, wo sie sind (siehe
  // taskShapeFromEvent). Gleiche Technik wie reconcileTimeSlots(): nach pull/push, ohne wartende Änderungen,
  // aktueller Google-Stand vor dem Patch, häppchenweise (CAL_RECONCILE_LIMIT), Fehler brechen den Sync nicht ab.
  async function reconcileCalendar(store, remote, opts, dirtyIds) {
    let tasks = await store.getRawTasks();
    // Lokale Tasks aus einer Version ohne Schalter kennen `in_calendar` noch nicht: wie beim Einlesen der Events
    // ableiten (nur Tasks mit Uhrzeit bleiben sichtbar) und die Event-Umstellung vormerken.
    if (tasks.some((t) => t.in_calendar === undefined)) {
      tasks = tasks.map((t) => {
        if (t.in_calendar !== undefined) return t;
        const in_calendar = !!(t.due_date && t.due_time);
        return { ...t, in_calendar, cal_migrate: !!t.google_event_id && !in_calendar };
      });
      await store.saveRawTasks(tasks);
    }
    const candidates = tasks.filter((t) => t.cal_migrate && t.google_event_id && !t.deleted && !dirtyIds.has(t.id) && !t.cal_failed);
    let updated = 0;
    for (const task of candidates.slice(0, CAL_RECONCILE_LIMIT)) {
      try {
        const fresh = await remote.get(task.google_event_id);
        const shape = taskShapeFromEvent(fresh);
        if (shape.cal_migrate) {
          const merged = { ...shape, id: task.id };
          const ev = await remote.patch(task.google_event_id, eventBody(merged, opts));
          tasks = tasks.map((t) => (t.id === task.id ? { ...t, ...merged, google_updated: ev.updated, ...writtenFields(merged, opts) } : t));
          updated++;
        } else {
          // Hat inzwischen ein anderes Gerät umgestellt: nur den Stand übernehmen.
          tasks = tasks.map((t) => (t.id === task.id ? { ...t, in_calendar: shape.in_calendar, cal_migrate: false, hidden_date: shape.hidden_date } : t));
        }
        await store.saveRawTasks(tasks);
      } catch (e) {
        const status = httpStatus(e);
        if (isGone(e)) continue;
        if (status >= 400 && status < 500 && status !== 429) {
          tasks = tasks.map((t) => (t.id === task.id ? { ...t, cal_failed: true } : t)); // dauerhaft abgelehnt: nicht ständig neu versuchen
          await store.saveRawTasks(tasks);
          continue;
        }
        break; // Netzwerkproblem, Limit (429) o. Ä.: Rest beim nächsten Sync
      }
    }
    return updated;
  }

  async function syncWith(store, remote) {
    const timeZone = (await remote.getTimeZone?.().catch(() => null)) || TIME_ZONE;
    const optsFor = async () => ({ ...resolveSettings((await store.getConfig())?.settings), timeZone });
    const optsBefore = await optsFor(); // lokaler Stand der Einstellungen, für Änderungen, die gerade gesendet werden
    const outboxBefore = await store.getOutbox();
    const dirtyIds = new Set(outboxBefore.map((e) => e.taskId));
    const pulled = await pull(store, remote, dirtyIds);
    const { sent, failed, clashes, aborted, abortReason } = await push(store, remote, optsBefore);
    await syncConfig(store, remote).catch(() => {}); // Konfiguration ist nice-to-have, darf den Task-Sync nicht blockieren
    // Danach erst die Umstellung auf die (ggf. gerade von einem anderen Gerät geänderte) Einstellung: so gilt
    // eine umgeschaltete Einstellung noch im selben Durchlauf, ohne dass die Reihenfolge Pull/Push/Konfiguration
    // sich ändert. Was push() mit dem älteren Stand gesendet hat, gleicht die Umstellung bei Bedarf gleich aus.
    const calUpdated = aborted ? 0 : await reconcileCalendar(store, remote, await optsFor(), new Set((await store.getOutbox()).map((e) => e.taskId))).catch(() => 0);
    const slotsUpdated = aborted ? 0 : await reconcileTimeSlots(store, remote, await optsFor(), new Set((await store.getOutbox()).map((e) => e.taskId))).catch(() => 0);
    return { pulled, pushed: sent.length, failed, clashes, aborted, abortReason, slotsUpdated, calUpdated };
  }

  return { syncWith, pull, push, syncConfig, reconcileTimeSlots, reconcileCalendar, hiddenDateFor, eventBody, taskShapeFromEvent, usesTimeSlot, withSlotIndex, slotTimes, resolveSettings, DEFAULT_SETTINGS, isHiddenDate, CONFIG_MARKER, DONE_PREFIX, DONE_COLOR, NO_DATE_PLACEHOLDER };
});
