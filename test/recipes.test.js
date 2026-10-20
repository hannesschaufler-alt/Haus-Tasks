const test = require('node:test');
const assert = require('node:assert');
const L = require('../public/offline-logic');
const S = require('../public/sync-core');
const SC = require('../public/shop-categories');

const SAMPLE = `Irgendein Text vor dem ersten Rezept wird ignoriert.

## Reisschüssel mit Rindfleisch
35 Minuten · 4 Portionen · Quelle: Mealime
Zutaten:
- 2 Salatgurken
* 200 g Jasminreis
• 0,7 kg Faschiertes
Anleitung:
1. Reis waschen und kochen.

2. Gurken in Scheiben schneiden.

## Zweites Gericht
Zutaten:
- 1 Zitrone
`;

test('parseRecipes: Titel, Kopf, Zutaten (mit verschiedenen Aufzählungszeichen) und Anleitung', () => {
  const r = L.parseRecipes(SAMPLE);
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].title, 'Reisschüssel mit Rindfleisch');
  assert.deepStrictEqual(r[0].checklist, [{ text: '2 Salatgurken', done: false }, { text: '200 g Jasminreis', done: false }, { text: '0,7 kg Faschiertes', done: false }]);
  assert.strictEqual(r[0].notes, '35 Minuten · 4 Portionen · Quelle: Mealime\n\n1. Reis waschen und kochen.\n\n2. Gurken in Scheiben schneiden.');
  assert.deepStrictEqual(r[1], { title: 'Zweites Gericht', notes: '', checklist: [{ text: '1 Zitrone', done: false }] });
});

test('parseRecipes: leere/fremde Eingaben ergeben nichts, Windows-Zeilenenden gehen', () => {
  assert.deepStrictEqual(L.parseRecipes(''), []);
  assert.deepStrictEqual(L.parseRecipes('nur Text ohne Rezept'), []);
  assert.deepStrictEqual(L.parseRecipes(undefined), []);
  assert.strictEqual(L.parseRecipes('## A\r\nZutaten:\r\n- x\r\n').length, 1);
});

test('Zutaten aus dem Rezept-Import werden von der Einkaufskategorie erkannt (Mengen und österreichische Wörter)', () => {
  const r = L.parseRecipes(SAMPLE)[0];
  assert.deepStrictEqual(r.checklist.map((i) => SC.categorize(i.text)), ['obst', 'vorrat', 'fleisch']);
});

// --- Lange Notizen und Checklisten (Rezepte) bei Google: je Zusatzfeld höchstens 1024 Zeichen ---
test('Lange Anleitung und lange Zutatenliste bleiben beim Senden unter 1024 Zeichen je Feld und kommen vollständig zurück', () => {
  const notes = Array.from({ length: 60 }, (_, i) => `${i + 1}. Schritt mit etwas mehr Text, damit die Anleitung lang genug wird.`).join('\n');
  const checklist = Array.from({ length: 40 }, (_, i) => ({ text: `${i + 1} Zutat Nummer ${i + 1}`, done: i % 3 === 0 }));
  assert.ok(notes.length > 3000);
  const body = S.eventBody({ title: 'Rezept', due_date: null, notes, checklist, priority: 'mittel', color: '9', id: 'x' });
  for (const [k, v] of Object.entries(body.extendedProperties.private)) assert.ok(String(v).length <= 900, `${k} hat ${String(v).length} Zeichen`);
  const back = S.taskShapeFromEvent(body);
  assert.strictEqual(back.notes, notes);
  assert.deepStrictEqual(back.checklist, checklist);
});

test('Kurze Notizen bleiben im bisherigen Feld „notes“ (alte Termine lesen sich weiter), zu lange Checklisten verlieren nur die letzten Punkte', () => {
  const body = S.eventBody({ title: 'T', notes: 'kurz', checklist: [{ text: 'a', done: false }], priority: 'mittel', color: '9', id: 'x' });
  assert.strictEqual(body.extendedProperties.private.notes, 'kurz');
  assert.strictEqual(S.taskShapeFromEvent({ summary: 'Alt', start: { date: '2031-01-01' }, extendedProperties: { private: { priority: 'mittel', notes: 'alter Termin', checklist: '[{"text":"x","done":true}]' } } }).notes, 'alter Termin');
  const riesig = Array.from({ length: 400 }, (_, i) => ({ text: `Zutat mit längerem Namen Nummer ${i}`, done: false }));
  const back = S.taskShapeFromEvent(S.eventBody({ title: 'T', checklist: riesig, priority: 'mittel', color: '9', id: 'x' }));
  assert.ok(back.checklist.length > 0 && back.checklist.length < 400);
  assert.deepStrictEqual(back.checklist, riesig.slice(0, back.checklist.length));
});

test('Herkunft der Zutat (Rezept-Titel): bereinigt, im Termin gespeichert, kommt zurück; alte Termine ohne Herkunft bleiben leer', () => {
  assert.deepStrictEqual(L.cleanSources(['Pizza', ' pizza ', '', 5, 'Curry', 'x'.repeat(200)]).map((s) => s.length), [5, 5, 80]);
  assert.strictEqual(L.cleanSources(Array.from({ length: 20 }, (_, i) => `R${i}`)).length, 8);
  const t = L.createTask([], { title: 'Zwiebeln', list_id: 'einkauf', sources: ['Pizza', 'Curry'] }, {}).task;
  assert.deepStrictEqual(t.sources, ['Pizza', 'Curry']);
  assert.deepStrictEqual(L.createTask([], { title: 'Salz' }, {}).task.sources, []);
  const body = S.eventBody({ ...t, priority: 'mittel', color: '9' });
  assert.strictEqual(body.extendedProperties.private.src, '["Pizza","Curry"]');
  assert.deepStrictEqual(S.taskShapeFromEvent(body).sources, ['Pizza', 'Curry']);
  assert.deepStrictEqual(S.taskShapeFromEvent({ summary: 'Alt', start: { date: '2031-01-01' }, extendedProperties: { private: { priority: 'mittel' } } }).sources, []);
  assert.deepStrictEqual(S.taskShapeFromEvent({ summary: 'Kaputt', start: { date: '2031-01-01' }, extendedProperties: { private: { priority: 'mittel', src: '{kaputt' } } }).sources, []);
  const lang = S.eventBody({ ...t, sources: Array.from({ length: 8 }, (_, i) => `Rezept mit einem sehr langen Namen Nummer ${i} `.repeat(2).slice(0, 80)), priority: 'mittel', color: '9' });
  assert.ok(lang.extendedProperties.private.src.length <= 900);
});

test('Einkaufsliste aufräumen: erledigte Einträge nach 7 Tagen weg; offene und frisch erledigte bleiben; manuell kategorisierte als Gedächtnis (jüngster je Name)', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const day = (n) => new Date(now - n * 864e5).toISOString();
  const tasks = [
    { id: 'a', title: 'Milch', done: true, done_at: day(10) }, // alt: weg
    { id: 'b', title: 'Brot', done: true, done_at: day(8) }, // alt: weg
    { id: 'c', title: 'Eier', done: true, done_at: day(3) }, // frisch erledigt: bleibt
    { id: 'd', title: 'Butter', done: false }, // offen: bleibt
    { id: 'e', title: 'Dings vom Markt', done: true, done_at: day(30), shop_cat: 'obst' }, // älter, gleicher Name …
    { id: 'f', title: '2 Dings vom Markt', done: true, done_at: day(9), shop_cat: 'obst' }, // … jüngster mit Kategorie bleibt als Gedächtnis
    { id: 'g', title: 'Altes Zeug', done: true, updated_at: day(20) }, // ohne done_at: updated_at zählt
    { id: 'h', title: 'Gelöscht', done: true, done_at: day(40), deleted: true }, // schon gelöscht: nicht nochmal
    { id: 'i', title: 'Kaputt', done: true, done_at: 'quatsch' }, // unlesbares Datum: lieber nichts tun
  ];
  const ids = L.staleDoneIds(tasks, { now, normalize: (s) => s.toLowerCase().replace(/^\d+\s*/, '') });
  assert.deepStrictEqual(ids.sort(), ['a', 'b', 'e', 'g']);
  assert.deepStrictEqual(L.staleDoneIds([], { now }), []);
  assert.deepStrictEqual(L.staleDoneIds(tasks, { now, days: 60 }), [], 'mit längerer Frist bleibt alles');
});

test('Gedächtnis-Einträge der Einkaufsliste (erledigt, manuelle Kategorie, älter als die Frist) gelten als versteckt', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const ago = (h) => new Date(now - h * 3600e3).toISOString();
  assert.strictEqual(L.isShopMemory({ done: true, shop_cat: 'obst', done_at: ago(30) }, { now, days: 1 }), true);
  assert.strictEqual(L.isShopMemory({ done: true, shop_cat: 'obst', done_at: ago(5) }, { now, days: 1 }), false, 'frisch erledigt: sichtbar und zurückholbar');
  assert.strictEqual(L.isShopMemory({ done: true, shop_cat: null, done_at: ago(300) }, { now, days: 1 }), false, 'ohne manuelle Kategorie: kein Gedächtnis');
  assert.strictEqual(L.isShopMemory({ done: false, shop_cat: 'obst', updated_at: ago(300) }, { now, days: 1 }), false, 'offen: nie versteckt');
  // Frist 1 Tag: nach 24 Stunden wird gelöscht, außer dem Gedächtnis-Eintrag
  const ids = L.staleDoneIds([{ id: 'a', title: 'Milch', done: true, done_at: ago(30) }, { id: 'b', title: 'Brot', done: true, done_at: ago(5) }], { now, days: 1 });
  assert.deepStrictEqual(ids, ['a']);
});
