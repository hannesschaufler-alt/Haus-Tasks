const test = require('node:test');
const assert = require('node:assert');
const SC = require('../public/shop-categories');

const cat = (t, learned) => SC.categorize(t, learned);

// Österreichische und deutsche Schreibweise: jedes Paar muss in derselben Kategorie landen.
const PAIRS = [
  ['milch', ['Topfen', 'Quark', 'Schlagobers', 'Obers', 'Sahne', 'Schlag', 'Schlagsahne', 'Rahm', 'Sauerrahm', 'Schmand', 'Kaffeeobers', 'Kaffeesahne']],
  ['fleisch', ['Faschiertes', 'Hackfleisch', 'Hack', 'Gemischtes Faschiertes', 'Beinschinken', 'Schinken', 'Extrawurst', 'Wurst', 'Leberkäse', 'Tafelspitz', 'Schlögel', 'Jause', 'Aufschnitt', 'Hühnerbrust', 'Hendl', 'Putenbrust', 'Lachsfilet']],
  ['obst', ['Paradeiser', 'Tomaten', 'Erdäpfel', 'Kartoffeln', 'Karfiol', 'Blumenkohl', 'Fisolen', 'grüne Bohnen', 'Kohlsprossen', 'Rosenkohl', 'Marillen', 'Aprikosen',
    'Heidelbeeren', 'Blaubeeren', 'Ribisel', 'Johannisbeeren', 'Zwetschken', 'Pflaumen', 'Melanzani', 'Aubergine', 'Rote Rüben', 'Rote Bete', 'Vogerlsalat', 'Feldsalat',
    'Kren', 'Frühlingszwiebel', 'Zwiebeln', 'Äpfel', 'Bananen', 'Petersilie', 'Schwammerl', 'Pilze', 'Gelbe Rüben', 'Karotten', 'Möhren', 'Kürbis']],
  ['brot', ['Semmel', 'Semmeln', 'Brötchen', 'Weckerl', 'Kipferl', 'Brot', 'Vollkornbrot', 'Toast', 'Krapfen', 'Faschingskrapfen', 'Striezel', 'Hefezopf', 'Palatschinken', 'Pfannkuchen', 'Croissant']],
  ['vorrat', ['Staubzucker', 'Puderzucker', 'Semmelbrösel', 'Bröseln', 'Paniermehl', 'Mehl', 'Dinkelmehl', 'Nudeln', 'Spaghetti', 'Basmatireis', 'Olivenöl', 'Rapsöl', 'Linsen', 'Tomatenmark', 'Dosentomaten', 'Kokosmilch', 'Erdnussbutter', 'Milchreis']],
  ['getraenke', ['Almdudler', 'Limo', 'Limonade', 'Mineralwasser', 'Soda', 'Orangensaft', 'Apfelsaft', 'Bier', 'Weißwein', 'Rotwein', 'Kaffee', 'Tee', 'Eistee', 'Cola']],
  ['gewuerze', ['Salz', 'Meersalz', 'Pfeffer', 'Paprikapulver', 'Ketchup', 'Senf', 'Sojasauce', 'Tomatensauce', 'Meerrettich', 'Essig', 'Balsamico']],
  ['tiefkuehl', ['Tiefkühlpizza', 'Pommes', 'Fischstäbchen', 'Eiscreme', 'Vanilleeis', 'TK Spinat', 'Rahmspinat']],
  ['suess', ['Butterkeks', 'Schokolade', 'Zuckerl', 'Gummibärchen', 'Chips', 'Salzstangerl', 'Kekse', 'Müsliriegel']],
  ['haushalt', ['Klopapier', 'Toilettenpapier', 'Küchenrolle', 'Küchenpapier', 'Zahnpasta', 'Spülmittel', 'Geschirrspültabs', 'Taschentücher', 'Alufolie', 'Backpapier']],
  ['milch', ['Eier', 'Freilandeier', 'Ei', 'Butter', 'Bio Butter', 'Joghurt', 'Käse', 'Frischkäse', 'Mozzarella', 'Vollmilch', 'Hafermilch', 'Mascarpone']],
];

test('Österreichische und deutsche Begriffe landen in derselben Kategorie', () => {
  const failures = [];
  for (const [expected, items] of PAIRS) {
    for (const item of items) if (cat(item) !== expected) failures.push(`${item}: ${cat(item)} statt ${expected}`);
  }
  assert.deepStrictEqual(failures, []);
});

test('Mengen und Einheiten stören die Erkennung nicht', () => {
  for (const [item, expected] of [['2 Zwiebeln', 'obst'], ['500 g Hack', 'fleisch'], ['1 Bund Petersilie', 'obst'], ['ca. ½ l Milch', 'milch'], ['2x Joghurt', 'milch'],
    ['3 EL Olivenöl', 'vorrat'], ['1 Packung Nudeln', 'vorrat'], ['250g Topfen', 'milch'], ['1,5 kg Erdäpfel', 'obst'], ['Milch (3,6%)', 'milch'], ['6 Stk. Semmeln', 'brot']]) {
    assert.strictEqual(cat(item), expected, item);
  }
  assert.strictEqual(SC.normalizeItem('2 Zwiebeln'), 'zwiebeln');
  assert.strictEqual(SC.normalizeItem('  500 g   Hack '), 'hack');
  assert.strictEqual(SC.normalizeItem('Frühlings-Zwiebel'), 'fruhlings zwiebel');
});

test('Ausnahmen und Fallstricke: das längste bzw. ausdrückliche Stichwort gewinnt', () => {
  assert.strictEqual(cat('Butterkeks'), 'suess');
  assert.strictEqual(cat('Erdnussbutter'), 'vorrat');
  assert.strictEqual(cat('Kokosmilch'), 'vorrat');
  assert.strictEqual(cat('Milchreis'), 'vorrat');
  assert.strictEqual(cat('Leberkäse'), 'fleisch');
  assert.strictEqual(cat('Käsekrainer'), 'fleisch');
  assert.strictEqual(cat('Palatschinken'), 'brot', 'enthält „Schinken“, ist aber keiner');
  assert.strictEqual(cat('Hühneroberschenkel'), 'fleisch', 'enthält „Obers“, ist aber kein Milchprodukt');
  assert.strictEqual(cat('Tortellini'), 'vorrat', 'enthält „Torte“');
  assert.strictEqual(cat('Wassermelone'), 'obst');
  assert.strictEqual(cat('Gewürzgurke'), 'vorrat');
  assert.strictEqual(cat('Schweinefleisch'), 'fleisch', 'enthält „Wein“');
  assert.strictEqual(cat('Reis'), 'vorrat', 'nicht als „Eis“ erkannt');
  assert.strictEqual(cat('Eis'), 'tiefkuehl');
  assert.strictEqual(cat('Pfefferminze'), 'obst');
  assert.strictEqual(cat('Pfefferminztee'), 'getraenke');
});

test('Unbekanntes bleibt „Nicht zugeordnet“ (null), leere Eingaben auch', () => {
  assert.strictEqual(cat('xyzzy'), null);
  assert.strictEqual(cat('Dings vom Markt'), null);
  assert.strictEqual(cat(''), null);
  assert.strictEqual(cat('   '), null);
  assert.strictEqual(cat('2'), null);
  assert.strictEqual(cat(undefined), null);
});

test('Gelernte Zuordnungen haben Vorrang vor dem Wörterbuch und gelten für denselben Namen (egal wie geschrieben)', () => {
  const tasks = [
    { title: 'Dings vom Markt', shop_cat: 'obst', updated_at: '2026-10-01' },
    { title: 'Salz', shop_cat: 'haushalt', updated_at: '2026-10-02' }, // absichtlich anders als das Wörterbuch
    { title: 'Ohne Wahl', shop_cat: null, updated_at: '2026-10-03' },
    { title: 'Kaputt', shop_cat: 'gibtsnicht', updated_at: '2026-10-04' },
  ];
  const learned = SC.buildLearned(tasks);
  assert.deepStrictEqual(Object.keys(learned).sort(), ['dings vom markt', 'salz']);
  assert.strictEqual(cat('2 Dings vom Markt', learned), 'obst', 'Menge davor ändert den Namen nicht');
  assert.strictEqual(cat('salz', learned), 'haushalt');
  assert.strictEqual(cat('Pfeffer', learned), 'gewuerze', 'anderer Name: weiter Wörterbuch');
  assert.strictEqual(cat('Ohne Wahl', learned), null);
});

test('buildLearned: die jüngste Wahl für denselben Namen gewinnt', () => {
  const learned = SC.buildLearned([
    { title: 'Schlag', shop_cat: 'suess', updated_at: '2026-10-01' },
    { title: 'schlag', shop_cat: 'milch', updated_at: '2026-10-05' },
  ]);
  assert.strictEqual(learned.schlag, 'milch');
});

test('categoryOf: ausdrückliche Wahl am Task vor Gelerntem und Wörterbuch', () => {
  assert.strictEqual(SC.categoryOf({ title: 'Milch', shop_cat: 'getraenke' }, {}), 'getraenke');
  assert.strictEqual(SC.categoryOf({ title: 'Milch', shop_cat: null }, {}), 'milch');
  assert.strictEqual(SC.categoryOf({ title: 'Unbekanntes Zeug' }, {}), null);
  assert.strictEqual(SC.categoryOf({ title: 'Milch', shop_cat: 'gibtsnicht' }, {}), 'milch', 'ungültige Kategorie wird ignoriert');
});

test('Kategorienliste: feste Reihenfolge, eindeutige IDs, Beschriftungen', () => {
  assert.deepStrictEqual(SC.CATEGORIES.map((c) => c.id), ['obst', 'brot', 'fleisch', 'milch', 'tiefkuehl', 'vorrat', 'getraenke', 'gewuerze', 'suess', 'haushalt', 'sonstiges']);
  assert.strictEqual(new Set(SC.CATEGORIES.map((c) => c.id)).size, SC.CATEGORIES.length);
  assert.strictEqual(SC.labelOf('obst'), 'Obst & Gemüse');
  assert.strictEqual(SC.labelOf(null), 'Nicht zugeordnet');
});
