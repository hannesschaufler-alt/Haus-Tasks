// Automatische Kategorien für die Einkaufsliste (wie die App Mealime): jeder Eintrag bekommt anhand eines Wörterbuchs
// eine Supermarkt-Kategorie. Österreichische und deutsche Begriffe gelten gleichberechtigt (Topfen/Quark, Schlagobers/Sahne,
// Faschiertes/Hackfleisch, Paradeiser/Tomaten …). Rein und ohne Abhängigkeiten, läuft unter Node (Tests) und im Browser
// (Global `ShopCategories`).
//
// Entscheidungsreihenfolge in categorize(): 1. gelernte Zuordnung (frühere manuelle Wahl für denselben Namen),
// 2. Wörterbuch (die Treffer konkurrieren über ihre Länge, der längste gewinnt, Ausrufezeichen-Einträge sind Ausnahmen mit Vorrang),
// 3. sonst null = „Nicht zugeordnet“ (wird von Hand eingeordnet).
//
// Schreibweise der Stichwörter (alles ohne Umlaute/Akzente geschrieben ist egal – beim Vergleich werden Umlaute entfernt):
//   wort    kommt irgendwo im Eintrag vor (auch als Teil eines zusammengesetzten Worts: „Vollmilch“, „Frühlingszwiebel“)
//   =wort   nur als ganzes Wort („ei“, „mais“, „hack“) – für kurze Wörter, die sonst in anderen stecken
//   $wort   als Wortende („Basmatireis“, „Olivenöl“)
//   !wort   Ausnahme mit Vorrang (z. B. „Butterkeks“ ist kein Milchprodukt, „Leberkäse“ kein Käse); kombinierbar mit = und $
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.ShopCategories = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Reihenfolge = typischer Gang durch den Supermarkt.
  const CATEGORIES = [
    { id: 'obst', label: 'Obst & Gemüse' },
    { id: 'brot', label: 'Brot & Gebäck' },
    { id: 'fleisch', label: 'Fleisch & Fisch' },
    { id: 'milch', label: 'Milchprodukte & Eier' },
    { id: 'tiefkuehl', label: 'Tiefkühl' },
    { id: 'vorrat', label: 'Vorrat' },
    { id: 'getraenke', label: 'Getränke' },
    { id: 'gewuerze', label: 'Gewürze & Saucen' },
    { id: 'suess', label: 'Süßes & Snacks' },
    { id: 'haushalt', label: 'Haushalt & Drogerie' },
    { id: 'sonstiges', label: 'Sonstiges' },
  ];
  const IDS = new Set(CATEGORIES.map((c) => c.id));

  const WORDS = {
    obst: `apfel, birne, banane, orange, mandarine, clementine, zitrone, limette, grapefruit, pomelo, traube, erdbeere, himbeere, heidelbeere, blaubeere,
      brombeere, johannisbeere, ribisel, stachelbeere, kirsche, weichsel, marille, aprikose, pfirsich, nektarine, zwetschke, zwetschge, pflaume, melone,
      ananas, mango, kiwi, avocado, feige, granatapfel, kaki, papaya, maracuja, beeren, obst, rhabarber, litschi, dattel,
      tomate, paradeiser, gurke, salat, paprika, zwiebel, knoblauch, lauch, porree, karotte, mohre, gelbe rube, karfiol, blumenkohl, brokkoli, broccoli, kohl,
      kohlrabi, kohlsprossen, rosenkohl, spinat, zucchini, melanzani, aubergine, fisole, grune bohne, erbse, kartoffel, erdapfel, rube, rote bete, sellerie,
      petersilwurzel, pastinake, radieschen, rettich, =kren, ingwer, fenchel, kurbis, champignon, pilz, schwammerl, spargel, mangold, rucola, vogerlsalat,
      feldsalat, chicoree, endivie, radicchio, petersilie, schnittlauch, basilikum, dill, koriander, minze, thymian, salbei, rosmarin, krauter, sprossen,
      keimling, gemuse, maiskolben, edamame, jungzwiebel, lauchzwiebel, !wassermelone, !krauterbutter:milch, !alkohol:getraenke, !mohrenkopf:brot`,
    brot: `brot, semmel, brotchen, weckerl, kipferl, geback, croissant, toast, baguette, laugen, brezel, breze, striezel, zopf, krapfen, kuchen, torte,
      muffin, plunder, mehlspeise, ciabatta, fladenbrot, =pita, =wrap, =wraps, =tortilla, gipfel, schnecke, donut, !palatschinken, !golatsche, !topfengolatsche,
      pfannkuchen, vollkornweckerl, sandwich, knackebrot, grissini, naan, croutons`,
    fleisch: `fleisch, faschiert, hackfleisch, =hack, =gehacktes, rind, schwein, kalb, huhn, hendl, hahnchen, huhner, =pute, puten, truthahn, lamm, wurst,
      wurstel, schinken, speck, salami, leberkase, kasekrainer, bierschinken, aufschnitt, jause, steak, schnitzel, cordon, kotelett, karree, schopf, filet,
      braten, gulasch, beinfleisch, tafelspitz, schlogel, keule, haxe, ripperl, rippchen, leber, =niere, nieren, entenbrust, =ente, =gans, wild, =reh, =hirsch,
      fisch, lachs, forelle, garnele, scampi, shrimp, kabeljau, seelachs, zander, hering, makrele, meeresfruchte, calamari, tintenfisch, matjes, pangasius,
      surimi, extrawurst, mortadella, pastrami, bratwurst, frankfurter, grillwurst, burger patty, sardinen, !oberschenkel, !oberschale`,
    milch: `milch, joghurt, jogurt, topfen, quark, skyr, =butter, obers, =schlag, sahne, rahm, schmand, creme fraiche, kase, mozzarella, parmesan, gouda,
      emmentaler, camembert, feta, mascarpone, ricotta, frischkase, =ei, =eier, $eier, kefir, margarine, !sauerrahm, !kaffeesahne, !kaffeeobers, !krauterbutter,
      butterkase, grana padano, halloumi, gorgonzola, bergkase, almkase, reibkase, scheibenkase, vanillepudding, tofu, seitan, tempeh`,
    tiefkuehl: `!tiefkuhl, !=tk, !pommes, !fischstabchen, !eiscreme, =eis, $eis, !tiefgekuhl, !=pizza, !=pizzas, rahmspinat, !gefrorene, !speiseeis, !eiswurfel, !vanilleeis, !schokoeis, !erdbeereis, !tortellini:vorrat, !ravioli:vorrat`,
    vorrat: `nudel, pasta, spaghetti, penne, fusilli, tagliatelle, makkaroni, spatzle, nockerl, gnocchi, knodel, =reis, $reis, couscous, bulgur, quinoa, polenta,
      griess, haferflocken, =mehl, $mehl, zucker, backpulver, =germ, hefe, trockenhefe, natron, starke, gelatine, pudding, konserve, dosentomaten, tomatenmark,
      passata, passierte tomaten, gehackte tomaten, kidneybohne, kichererbse, linsen, =bohnen, =mais, !thunfisch, sardellen, olive, kapern, sauerkraut,
      essiggurke, !gurkerl, pfefferoni, nutella, marmelade, konfitura, konfiture, honig, !erdnussbutter, erdnusscreme, aufstrich, brotaufstrich, musli, cornflakes,
      cerealien, nuss, mandel, rosine, trockenfruchte, !kokosmilch, kokosraspel, =ol, $ol, speiseol, !butterschmalz, schmalz, kokosfett, !milchreis, !semmelbrosel,
      =brosel, =broseln, paniermehl, suppe, blatterteig, germteig, hummus, sonnenblumenkerne, kurbiskerne, leinsamen, chiasamen, sesam, tahini, dosenmais, erdnuss, !backmischung,
      !marzipanrohmasse, vanillezucker, gelierzucker, !staubzucker, !puderzucker`,
    getraenke: `wasser, !mineralwasser, sprudel, soda, selters, !saft, schorle, limonade, =limo, cola, fanta, almdudler, sprite, !eistee, bier, wein, sekt, prosecco,
      spritzer, wodka, =gin, =rum, likor, schnaps, obstler, =most, kaffee, =tee, $tee, kakao, energy, redbull, radler, malzbier, !schokomilch, kaffeefilter:haushalt, ice tea, aperol,
      !hafermilch:milch, !sojamilch:milch, !mandelmilch:milch, !wassermelone:obst`,
    gewuerze: `=salz, $salz, pfeffer, !paprikapulver, curry, zimt, muskat, oregano, majoran, kurkuma, kreuzkummel, kummel, lorbeer, chili, cayenne, gewurz, senf,
      ketchup, mayonnaise, =mayo, sojasauce, !sauce, !sose, !dressing, essig, balsamico, sambal, sriracha, pesto, bruhe, bruhwurfel, suppenwurfel, vanille,
      meerrettich, wasabi, ajvar, harissa, miso, !krautersalz, worcester, tabasco, !knoblauchpulver, !zwiebelpulver, !korianderpulver, !koriander gemahlen, !ingwerpulver, gewurzmischung, paprikagewurz, !senfgurke:vorrat, !gewurzgurke:vorrat, !pfefferminze:obst, !pfefferminztee:getraenke`,
    suess: `schokolade, schoko, nougat, praline, keks, biskuit, waffel, gummibar, haribo, bonbon, !zuckerl, lutscher, kaugummi, lakritz, chips, snack, popcorn,
      !salzstangerl, !salzstange, knabber, flips, cracker, riegel, marzipan, lebkuchen, oblaten, =manner, !milchschnitte, !milchschokolade, !butterkeks,
      sussigkeit, dragee, !nussecke, nusskonfekt, schokobons, kinder riegel, kinderschokolade, mannerschnitten, soletti`,
    haushalt: `klopapier, toilettenpapier, kuchenrolle, taschentuch, tucher, spulmittel, spulmaschinentabs, spultabs, geschirrspul, =tabs, waschmittel, weichspuler, reiniger, putzmittel,
      schwamm, mullbeutel, mullsack, gefrierbeutel, alufolie, backpapier, papier, frischhaltefolie, =folie, serviette, kerze, batterie, gluhbirne, leuchtmittel,
      zahnpasta, zahnburste, zahnseide, shampoo, duschgel, seife, =deo, deodorant, handcreme, rasierer, rasierschaum, =binden, tampon, windel, feuchttucher,
      pflaster, katzenfutter, hundefutter, =futter, katzenstreu, blumenerde, zundholz, streichholz, feuerzeug, =wc, wc stein, entkalker, geschirrtuch,
      spulbecken, kuchenpapier, kuchentuch, backofenreiniger, putztuch, mullbeutel, haarspray, sonnencreme, zahnputz, mundwasser, wattestabchen, wattepads, nagellack`,
  };

  // Ein „Wort:kategorie“-Eintrag legt die Kategorie ausdrücklich fest (statt der Gruppe, in der er steht).
  function fold(s) {
    return String(s ?? '').toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  const RULES = []; // { kind: 'contains' | 'word' | 'suffix', kw, cat, score, order }
  Object.entries(WORDS).forEach(([cat, list]) => {
    list.split(',').map((x) => x.trim()).filter(Boolean).forEach((raw) => {
      let entry = raw;
      let target = cat;
      const colon = entry.lastIndexOf(':');
      if (colon > 0 && IDS.has(entry.slice(colon + 1))) { target = entry.slice(colon + 1); entry = entry.slice(0, colon); }
      let strong = false, word = false, suffix = false;
      for (;;) {
        if (entry[0] === '!') { strong = true; entry = entry.slice(1); }
        else if (entry[0] === '=') { word = true; entry = entry.slice(1); }
        else if (entry[0] === '$') { suffix = true; entry = entry.slice(1); }
        else break;
      }
      const kw = fold(entry);
      if (!kw) return;
      RULES.push({ kind: word ? 'word' : suffix ? 'suffix' : 'contains', kw, cat: target, score: kw.length + (word ? 2 : suffix ? 1 : 0) + (strong ? 100 : 0), order: CATEGORIES.findIndex((c) => c.id === target) });
    });
  });

  const UNITS = '(?:kg|g|gr|mg|l|ml|dl|cl|el|tl|stk|stuck|pkg|pck|pkt|packung(?:en)?|packerl|packchen|bund|bd|dose(?:n)?|glas|glaser|flasche(?:n)?|becher|tute(?:n)?|scheibe(?:n)?|prise|x|mal|liter|gramm|kilo)';
  // Entfernt führende Mengenangaben („2 Zwiebeln“, „500 g Hack“, „1 Bund Petersilie“, „ca. ½ l Milch“) und Klammern, damit sie die Suche nicht stören.
  function normalizeItem(title) {
    let s = fold(title).replace(/\([^)]*\)/g, ' ').replace(/["„“”'‚‘’`]/g, '');
    for (let i = 0; i < 3; i++) {
      const before = s;
      s = s.replace(new RegExp(`^\\s*(?:ca\\.?\\s*)?[\\d½¼¾][\\d.,/½¼¾\\s-]*\\s*${UNITS}?\\b\\.?\\s*`), '');
      s = s.replace(new RegExp(`^\\s*${UNITS}\\b\\.?\\s+`), '');
      if (s === before) break;
    }
    return s.replace(/[-–_/,;:+*]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Wörterbuch-Treffer: Kategorie-ID oder null.
  function fromDictionary(norm) {
    if (!norm) return null;
    const words = norm.split(' ');
    let best = null;
    for (const r of RULES) {
      const hit = r.kind === 'contains' ? norm.includes(r.kw)
        : r.kind === 'word' ? words.includes(r.kw)
        : words.some((w) => w.length >= r.kw.length && w.endsWith(r.kw));
      if (!hit) continue;
      if (!best || r.score > best.score || (r.score === best.score && r.order < best.order)) best = r;
    }
    return best ? best.cat : null;
  }

  // `learned`: { normalisierter Name: Kategorie-ID } aus früheren manuellen Zuordnungen (siehe buildLearned).
  function categorize(title, learned = {}) {
    const norm = normalizeItem(title);
    const l = learned[norm];
    if (l && IDS.has(l)) return l;
    return fromDictionary(norm);
  }

  // Aus den Tasks der Einkaufsliste lernen: jede manuell gewählte Kategorie (auch bei erledigten Einträgen) gilt künftig für denselben Namen.
  function buildLearned(tasks) {
    const map = {};
    for (const t of [...tasks].sort((a, b) => (a.updated_at || '').localeCompare(b.updated_at || ''))) {
      if (t.shop_cat && IDS.has(t.shop_cat)) map[normalizeItem(t.title)] = t.shop_cat; // der jüngste gewinnt
    }
    return map;
  }

  // Kategorie eines Tasks: ausdrückliche Wahl, sonst gelernt/Wörterbuch, sonst null (= „Nicht zugeordnet“).
  function categoryOf(task, learned = {}) {
    if (task.shop_cat && IDS.has(task.shop_cat)) return task.shop_cat;
    return categorize(task.title, learned);
  }

  const labelOf = (id) => CATEGORIES.find((c) => c.id === id)?.label || 'Nicht zugeordnet';

  return { CATEGORIES, normalizeItem, categorize, buildLearned, categoryOf, labelOf };
});
