const test = require('node:test');
const assert = require('node:assert');
const { nextOccurrence, normalizeRule } = require('../public/recurrence');

test('wöchentlich: +7 Tage ab altem Fälligkeitsdatum', () => {
  assert.strictEqual(nextOccurrence({ type: 'weekly', interval: 1 }, '2026-09-22', '2026-09-01'), '2026-09-29');
  assert.strictEqual(nextOccurrence({ type: 'weekly', interval: 2 }, '2026-09-22', '2026-09-01'), '2026-10-06');
});

test('2. Dienstag im Monat', () => {
  const rule = { type: 'monthly_weekday', nth: 2, weekday: 2 };
  // 2. Dienstag im Sep 2026 = 8.9., im Okt = 13.10.
  assert.strictEqual(nextOccurrence(rule, '2026-09-08', '2026-09-01'), '2026-10-13');
  assert.strictEqual(nextOccurrence(rule, '2026-12-08', '2026-12-01'), '2027-01-12');
});

test('letzter Freitag im Monat', () => {
  const rule = { type: 'monthly_weekday', nth: -1, weekday: 5 };
  assert.strictEqual(nextOccurrence(rule, '2026-09-25', '2026-09-01'), '2026-10-30');
});

test('5. Montag wird übersprungen, wenn der Monat keinen hat', () => {
  const rule = { type: 'monthly_weekday', nth: 5, weekday: 1 };
  // 5. Montag: 29.6.2026, Juli hat keinen (27.7. ist der 4.), August: 31.8.
  assert.strictEqual(nextOccurrence(rule, '2026-06-29', '2026-06-01'), '2026-08-31');
});

test('Tag x im Monat, kurze Monate nehmen den letzten Tag', () => {
  const rule = { type: 'monthly_day', day: 31 };
  assert.strictEqual(nextOccurrence(rule, '2026-01-31', '2026-01-01'), '2026-02-28');
  assert.strictEqual(nextOccurrence(rule, '2026-02-28', '2026-01-01'), '2026-03-31');
});

test('jährlich, 29. Februar bleibt am Anker', () => {
  const rule = normalizeRule({ type: 'yearly' }, '2028-02-29');
  assert.strictEqual(nextOccurrence(rule, '2028-02-29', '2028-01-01'), '2029-02-28');
  assert.strictEqual(nextOccurrence(rule, '2029-02-28', '2028-01-01'), '2030-02-28');
  assert.strictEqual(nextOccurrence(rule, '2031-02-28', '2028-01-01'), '2032-02-29');
});

test('alle n Monate', () => {
  const day = { type: 'monthly_day', day: 15, interval: 6 };
  assert.strictEqual(nextOccurrence(day, '2031-03-15', '2031-01-01'), '2031-09-15');
  assert.strictEqual(nextOccurrence(day, '2031-09-15', '2031-01-01'), '2032-03-15');
  const quarterly = { type: 'monthly_day', day: 31, interval: 3 };
  assert.strictEqual(nextOccurrence(quarterly, '2031-01-31', '2031-01-01'), '2031-04-30');
  const wd = { type: 'monthly_weekday', nth: 2, weekday: 2, interval: 2 };
  assert.strictEqual(nextOccurrence(wd, '2031-09-09', '2031-01-01'), '2031-11-11'); // 2. Dienstag im November
});

test('alle n Jahre', () => {
  const rule = normalizeRule({ type: 'yearly', interval: 4 }, '2031-05-20');
  assert.strictEqual(nextOccurrence(rule, '2031-05-20', '2031-01-01'), '2035-05-20');
  const leap = normalizeRule({ type: 'yearly', interval: 10 }, '2032-02-29');
  assert.strictEqual(nextOccurrence(leap, '2032-02-29', '2031-01-01'), '2042-02-28');
});

test('spät abgehakt: erster Termin ab heute', () => {
  const rule = { type: 'weekly', interval: 1 };
  assert.strictEqual(nextOccurrence(rule, '2026-08-04', '2026-09-21'), '2026-09-22');
});

test('normalizeRule leitet Wochentag und Nummer aus dem Datum ab', () => {
  const r = normalizeRule({ type: 'monthly_weekday' }, '2026-09-08');
  assert.deepStrictEqual([r.nth, r.weekday], [2, 2]);
});
