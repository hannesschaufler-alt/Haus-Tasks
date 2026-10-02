// Serienregeln:
// `interval` (optional, Standard 1) zählt Wochen, Monate bzw. Jahre: alle 6 Monate, alle 2 Jahre usw.
//   { type: 'weekly', interval: 1 }                 jede n-te Woche, am Wochentag des Fälligkeitsdatums
//   { type: 'monthly_weekday', nth: 2, weekday: 2 } jeder 2. Dienstag im Monat (nth -1 = letzter)
//   { type: 'monthly_day', day: 15 }                jeden 15. des Monats (kürzere Monate: letzter Tag)
//   { type: 'yearly', month: 3, day: 1 }            jährlich
// Alle Daten sind 'YYYY-MM-DD'-Strings, gerechnet wird in UTC, damit keine Zeitzonen stören.

function parse(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
}

function fmt(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function addDays(iso, n) {
  const { y, m, d } = parse(iso);
  return fmt(y, m, d + n);
}

// Für Termine mit Uhrzeit: addiert Minuten auf ein Datum+Uhrzeit-Paar, rollt dabei korrekt über Mitternacht
// in den nächsten Tag (z. B. für das Ende eines um 23:30 beginnenden, einstündigen Termins).
function addMinutes(dateIso, time, n) {
  const { y, m, d } = parse(dateIso);
  const [hh, mm] = time.split(':').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, hh, mm + n));
  const pad = (x) => String(x).padStart(2, '0');
  return { date: dt.toISOString().slice(0, 10), time: `${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}` };
}

// Datum des n-ten Wochentags (0 = Sonntag) in einem Monat; nth -1 = letzter.
function nthWeekday(y, m, nth, weekday) {
  if (nth === -1) {
    const last = daysInMonth(y, m);
    const lastWd = new Date(Date.UTC(y, m - 1, last)).getUTCDay();
    return fmt(y, m, last - ((lastWd - weekday + 7) % 7));
  }
  const firstWd = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const day = 1 + ((weekday - firstWd + 7) % 7) + (nth - 1) * 7;
  return day <= daysInMonth(y, m) ? fmt(y, m, day) : null; // z. B. 5. Montag existiert nicht immer
}

function candidateInMonth(rule, y, m) {
  if (rule.type === 'monthly_weekday') return nthWeekday(y, m, rule.nth, rule.weekday);
  if (rule.type === 'monthly_day') return fmt(y, m, Math.min(rule.day, daysInMonth(y, m)));
  if (rule.type === 'yearly') return fmt(y, rule.month, Math.min(rule.day, daysInMonth(y, rule.month)));
  throw new Error(`Unbekannter Serientyp: ${rule.type}`);
}

// Erster Termin der Serie strikt nach `after`. `interval` zählt Wochen, Monate bzw. Jahre.
function stepAfter(rule, after) {
  const interval = Math.max(1, rule.interval || 1);
  if (rule.type === 'weekly') return addDays(after, 7 * interval);
  const { y, m } = parse(after);
  // Monatliche Serien prüfen jeden n-ten Monat ab dem Monat von `after`, jährliche jedes n-te Jahr.
  const monthsPerStep = rule.type === 'yearly' ? 12 * interval : interval;
  for (let k = 0; k < 400; k++) {
    const total = m - 1 + k * monthsPerStep;
    const cand = candidateInMonth(rule, y + Math.floor(total / 12), (total % 12) + 1);
    if (cand && cand > after) return cand;
  }
  throw new Error('Kein Folgetermin gefunden');
}

// Folgetermin ab dem alten Fälligkeitsdatum. Liegt er vor `today` (spät abgehakt),
// wird der erste Termin ab heute genommen.
function nextOccurrence(rule, from, today) {
  let cur = stepAfter(rule, from);
  while (today && cur < today) cur = stepAfter(rule, cur);
  return cur;
}

// Ergänzt Ankerwerte, die vom Fälligkeitsdatum abhängen.
function normalizeRule(rule, dueDate) {
  if (!rule) return null;
  const r = { ...rule };
  if (r.type === 'yearly' && dueDate && (!r.month || !r.day)) {
    const { m, d } = parse(dueDate);
    r.month = m;
    r.day = d;
  }
  if (r.type === 'monthly_day' && dueDate && !r.day) r.day = parse(dueDate).d;
  if (r.type === 'monthly_weekday' && dueDate && r.weekday === undefined) {
    const { y, m, d } = parse(dueDate);
    r.weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (!r.nth) r.nth = Math.ceil(d / 7);
  }
  return r;
}

// Läuft sowohl unter Node (Server, Tests) als auch als <script> im Browser (Offline-Logik der App).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { nextOccurrence, normalizeRule, addDays, addMinutes };
} else if (typeof self !== 'undefined') {
  self.Recurrence = { nextOccurrence, normalizeRule, addDays, addMinutes };
}
