# Haus-Tasks

Aufgabenverwaltung für Haus und Garten, direkt zwischen allen Geräten synchronisiert über einen
**geteilten Google-Kalender** – ganz ohne eigenen Server. Jedes Gerät (PC, Handy) hat seine eigene
Installation (eine statisch gehostete Seite), meldet sich mit dem eigenen Google-Konto an und
synchronisiert direkt mit Google. Liste, Zuständigkeit, Priorität, Notizen, Checkliste und Serie
stecken dabei versteckt in jedem Kalendertermin mit (Google selbst zeigt nur Titel, Datum und Farbe an).

- **Mehrere Listen (Reiter unter der Kopfzeile, „＋“ legt eine neue an, „✎“ bearbeitet die aktive):** z. B. Tasks, Einkaufsliste, Speiseplan, Elektriker. Jede Liste hat Name und Farbe (die Farbe tragen die Termine im Google-Kalender, beim Umfärben ziehen offene Tasks mit); die Schnellerfassung legt in die aktive Liste an. Nur die Hauptliste „Tasks“ (nicht löschbar) hat eine Inbox, in allen anderen Listen landet alles direkt in der Liste. Einen Task verschiebt man über das Feld „Liste“ im Detailformular oder in der Mehrfachbearbeitung. Eine Liste zu löschen löscht auch ihre Tasks (nach Rückfrage). Die Listen liegen in den gemeinsamen Einstellungen (versteckter Konfigurations-Termin, `settings.lists`), der Task trägt seine Liste im versteckten Feld `list`; ein Task mit unbekannter Liste erscheint in der Hauptliste. **Kategorien, Orte und ihre Filter gibt es nicht mehr** (bestehende Werte bleiben unsichtbar im Termin erhalten); der Filter „Wer“ (Caro/Hannes) bleibt.
- **„Später“ ist eine eigene Liste** (feste ID `spaeter`, wird beim ersten Verschieben bzw. bei der Umstellung automatisch angelegt): „→ Später“ in der Zeile und „Später“ in der Inbox verschieben dorthin, „↑ Tasks“ zurück. Die Liste ist nach Anlagedatum sortiert (älteste zuerst), und ein neu vergebenes Datum holt einen Task automatisch zurück in die Hauptliste. Tasks mit dem früheren Status „Später“ werden beim nächsten Laden/Sync einmalig (auch von noch nicht aktualisierten Geräten nachgelagert) in diese Liste verschoben; die Hauptliste hat nur noch Inbox und „Anstehend“.
- **Manuelle Sortierung per Drag&Drop:** In der Sortierauswahl jeder Liste gibt es „Manuell (per Ziehen)“ – dann hat jede offene Zeile links einen Griff „⠿“ zum Verschieben. Vorgabe ist sie für die Einkaufsliste; die Wahl gilt je Liste und wird auf dem Gerät gemerkt („Später“ ist standardmäßig nach Alter sortiert, alle anderen nach Fälligkeit). Die Position (`order`, versteckt im Termin) wandert mit zu allen Geräten. Beim Verschieben bekommt nur der gezogene Task eine neue Position (Mittelwert seiner Nachbarn); erst wenn das nicht geht (z. B. beim ersten Sortieren, wenn noch keiner eine Position hat) werden alle durchnummeriert. Neue Tasks ohne Position stehen oben. Solange der Filter „Wer“ aktiv ist oder im Auswahlmodus gibt es keine Griffe.
- **Gut erkennbare Abhak-Kreise:** Alle runden Kreise (Tasks, Checklisten-Punkte, Auswahlmodus) haben einen deutlich kräftigeren Rand (`--ring`), auch im Dunkelmodus. Die aufgeklappte Checkliste liegt in einer eigenen Rasterzeile unter dem Task – Häkchen, Titel und der Auf-/Zuklapp-Knopf bleiben beim Aufklappen oben in der Zeile.
- **Gerichte & Einkaufsliste:** (a) Stellt man einen erledigten Task wieder auf „offen“, springt seine Checkliste auf „nicht erledigt“ zurück (gilt für alle Tasks, z. B. ein Gericht, das man noch einmal kocht; das Zurücksetzen wandert als Teil der Änderung zu Google und zu den anderen Geräten). (b) Der Knopf „🛒 An Einkaufsliste senden“ unter der Checkliste (im Detailformular und in der aufgeklappten Checkliste in der Zeile) legt jeden Punkt als eigenen Task auf der Einkaufsliste an – der erste Punkt oben; Punkte, die dort schon offen stehen, werden nicht doppelt angelegt. Einkaufsliste = die Liste mit dem Häkchen „🛒 Das ist meine Einkaufsliste“ (✎ am Reiter), sonst die erste Liste mit „Einkauf“ im Namen. Der Knopf erscheint nicht bei Tasks, die selbst auf der Einkaufsliste liegen.
- **Drag&Drop (Checkliste, Listen-Reiter):** Bewegung und Loslassen werden am Dokument abgehört (nicht per Zeiger-Erfassung am Element, die beim Umsortieren im DOM verloren ging und Felder verschoben stehen ließ); das gezogene Feld folgt dem Zeiger, bleibt aber immer im Raster seines Containers.
- **Neue Tasks stehen oben:** In der Inbox sortiert nach Eingang (neueste zuerst); in den Listen steht bei der Standardsortierung („Fälligkeit, Neue zuerst“) alles ohne Datum – also frisch eingetragene Tasks – ganz oben, neueste zuerst; Tasks mit Datum folgen nach Fälligkeit, dann Priorität. Die Liste „Später“ bleibt bewusst nach Alter sortiert (älteste zuerst).
- **Update-Sicherheit:** Beim Deploy trägt die GitHub-Action den Commit als `?v=…` an die Skript-Adressen in `index.html` an, und der Service Worker fragt immer beim Server nach (`cache: 'no-cache'`). Vorher konnte der Browser-Cache (GitHub Pages: 10 Minuten) eine neue `index.html` mit einer alten `offline-logic.js` mischen – dann schlug z. B. die Umstellung auf die Liste „Später“ still fehl. Die Liste „Später“ wird einmalig immer angelegt (Einstellung `laterMigrated`), Fehler der Umstellung werden als Hinweis angezeigt.
- **Reihenfolge der Listen per Drag&Drop:** Reiter mit der Maus ziehen, am Handy kurz gedrückt halten und dann ziehen (sonst scrollt die Reiterleiste). Die Reihenfolge liegt in den gemeinsamen Einstellungen und gilt für alle Geräte.
- **GTD-Workflow:** Schnellerfassung oben auf der Startseite (nur Titel, Enter) legt einen Task in einer eigenen Inbox an; von dort per Klick „To Do“ oder „Später“ zuordnen (oder bei Kleinkram gleich „✓“ erledigen). „Anstehend“ und „Später“ sind eigene auf-/zuklappbare Bereiche auf der Startseite (Später standardmäßig eingeklappt), „Später“ sortiert nach Anlagedatum (älteste zuerst), damit nichts in Vergessenheit gerät. Ein Datum zu vergeben befördert einen „Später“-Task automatisch zurück zu „To Do“
- **Kompakte Listenansicht (wie Asanas List View, ca. 43 px pro Zeile, Inbox-Zeilen gleich hoch):** eine Zeile pro Task – Häkchen, Titel, rechts Checklisten-Stand, Datum (antippen = Datumswähler) und Zuständigkeit. „→ Später“ erscheint am Desktop beim Darüberfahren; auf dem Handy steht dafür im Detailformular das Feld „Status“. Die Schnellerfassung steht fest über der Liste und behält Fokus und Tastatur, auch wenn sich die Liste durch Speichern/Sync neu aufbaut – so lassen sich mehrere Einträge direkt hintereinander eintippen
- **Mehrfachbearbeitung:** „☑ Auswählen“ bei „Anstehend“ schaltet die Liste in den Auswahlmodus: mehrere Tasks antippen (oder „Alle“), dann „Bearbeiten …“ – Datum (auch entfernen), Liste, „In Google Kalender“, Zuständigkeit, Priorität und Status (To Do/Später) lassen sich für alle auf einmal setzen; nur was man ändert, wird überschrieben. Schlägt eine Änderung bei einzelnen Tasks fehl (z. B. Datum entfernen bei einer Serie), werden die übrigen trotzdem geändert und die Ausnahmen gemeldet
- **Unsichtbarer Sync – nur ausgewählte Tasks im Google-Kalender (Haken „In Google Kalender anzeigen“ im Detailformular und in der Mehrfachbearbeitung):** Nur Tasks mit Haken stehen an ihrem Datum im Kalender (📅 in der Liste). Neue Tasks haben den Haken standardmäßig aus; sobald eine Uhrzeit gesetzt wird, schaltet er sich von selbst ein; ohne Datum gibt es nichts anzuzeigen. Alle anderen Tasks synchronisieren weiter zwischen den Geräten, liegen im Google-Kalender aber als privater, „freier“ Ganztagstermin ohne Erinnerung auf einem weit zurückliegenden Tag (1971–1981, aus der Task-ID abgeleitet und über ~3.650 Tage gestreut, damit nicht Hunderte Termine an einem Tag hängen; der Tag bleibt stabil, `hidden_date`). Das echte Datum/die Uhrzeit stehen dann in den versteckten Feldern `due`, `dueTime`, `dueEnd`, der Marker `cal` ist `show` oder `hide`. Google veröffentlicht kein festes Limit pro Tag, nur Anfragelimits pro Minute – deshalb läuft die einmalige Umstellung bestehender Tasks häppchenweise (30 je Sync, danach automatisch der nächste Durchgang): bestehende Tasks mit Uhrzeit bleiben sichtbar, alle anderen wandern auf alte Tage; direkt in Google angelegte Termine werden nicht angefasst. Der Haken gilt für den Tagesende-Platz unten: nur Tasks mit Haken bekommen ihn. Beide Geräte müssen die neue App-Version geladen haben (ältere Versionen würden versteckte Termine falsch lesen).
- **Datumsanzeige ab 2026:** Fälligkeitsdaten vor dem 1.1.2026 werden in der App nicht angezeigt (gelten als „kein Datum“). Daten aus dem Bereich der versteckten Termine (1971–1981) sind nie echt – sie stammen von einer älteren App-Version, die den versteckten Tag als Datum zurückgeschrieben hat – und werden einmalig lokal und in Google zurückgesetzt.
- **Optionale Uhrzeit:** Ein Task kann zusätzlich zum Datum eine feste Uhrzeit (plus optionales Ende, sonst 1 Stunde Vorgabe) bekommen (z. B. wenn aus einer Vorbereitung ein echter Termin wird) – wird dann als normaler Termin mit Zeitfenster statt als ganztägiger Termin angelegt. Uhrzeit nur zusammen mit einem Datum, Ende nur zusammen mit einer Uhrzeit; das jeweils übergeordnete Feld zu entfernen löscht das untergeordnete automatisch mit
- **Tasks ohne Uhrzeit am Tagesende (Einstellung ⚙, standardmäßig an):** Ein Task mit Datum, aber ohne Uhrzeit, wäre in Google Kalender ein Ganztagstermin und stünde in Monats-, Wochen- und Tagesansicht über allen normalen Terminen – bei vielen Tasks an einem Tag schiebt das die eigenen Termine nach unten. Mit der Einstellung legt die App solche Tasks stattdessen als kurzen Termin am Tagesende an (Zeitzone des Kalenders, ohne Erinnerung, weiterhin „frei“ statt „beschäftigt“). Damit die Titel in der Tagesansicht lesbar bleiben (Google zeichnet Termine unter ca. 25 Minuten nur als Strich, Termine mit gleicher Startzeit stehen nebeneinander), hat jeder Task einen **Platz**: 25 Minuten lang, je 3 Tasks nebeneinander, 4 Plätze von hinten gezählt (23:34–23:59, 23:09–23:34, 22:44–23:09, 22:19–22:44) = 12 Tasks pro Tag, weitere teilen sich die am wenigsten belegten Plätze. Ein Platz bleibt stabil (auch wenn andere Tasks erledigt oder gelöscht werden; bei einem anderen Datum wird neu vergeben). In der App bleibt es ein Task ohne Uhrzeit – versteckte Merkfelder `noTime` (Platzhalter statt echter Uhrzeit) und `slot` (Platznummer). Die Einstellung gilt für alle Geräte (sie liegt im selben versteckten Konfigurations-Termin wie Kategorien/Orte) und stellt beim Umschalten **alle bestehenden Tasks** im Kalender um, jeweils bis zu 40 pro Sync, der Rest folgt automatisch beim nächsten; dasselbe gilt für Platzhalter einer früheren Version (23:58–23:59, noch ohne Platz). Aus: Tasks ohne Uhrzeit sind wieder Ganztagstermine. Tasks mit echter Uhrzeit und alle Tasks ohne Haken (versteckter Termin auf einem alten Tag) sind davon nicht betroffen. Nebenwirkung in Google: in der Monatsansicht erscheint der Termin als „Uhrzeit Titel“ mit Punkt statt als farbiger Balken, und wie viele Einträge eine Tageskachel zeigt, bestimmt allein Google (danach „+N“).
- **Offline-fähig:** Anlegen, Bearbeiten, Abhaken, Löschen funktionieren immer, auch ohne Verbindung. Sync automatisch oder per Knopfdruck, siehe „Offline & Sync“ unten
- Serien legen den Folgetermin erst beim Abhaken an, berechnet ab dem alten Fälligkeitsdatum. Rhythmus wählbar: alle n Wochen, Monate oder Jahre, n-ter Wochentag im Monat, Tag x im Monat
- Checkliste pro Task („Sub-Tasks light“): Punkte im Formular anlegen, in der Übersicht über das Badge „☑ 2/5“ aufklappen und direkt abhaken
- Mehrere Listen (siehe oben), geteilt über alle Geräte
- **Zuständigkeit** (Caro/Hannes, fest eingestellt in `public/index.html` und `public/offline-logic.js`, Konstante `ASSIGNEES`): Avatar-Kürzel in der App, im Google-Kalender-Titel als „(C)“ bzw. „(H)“ sichtbar
- Konfliktschutz: Vor jeder Änderung wird der aktuelle Google-Stand geholt, nur das tatsächlich geänderte Feld überschrieben – zwei Geräte können gleichzeitig unterschiedliche Felder desselben Tasks ändern, ohne sich zu überschreiben

## Einrichtung (einmalig, für die Person, die die App aufsetzt)

### 1. Google-Cloud-Projekt und OAuth-Zugang

1. https://console.cloud.google.com öffnen, neues Projekt anlegen (z. B. „Haus-Tasks“). Kostenlos, kein Rechnungskonto nötig.
2. **APIs & Dienste → Bibliothek → Google Calendar API → Aktivieren**.
3. **APIs & Dienste → OAuth-Zustimmungsbildschirm** (bzw. „Google Auth Platform“): Nutzertyp „Extern“, App-Name frei wählen, deine Gmail-Adresse als Support- und Kontakt-Mail.
4. **Branding**: App-Name, Support-Mail und Entwickler-Mail ausfüllen. Für Startseite/Datenschutz reicht ein öffentlich erreichbarer Kurztext, z. B. ein GitHub-Gist (siehe Hinweise unten, falls Google das für „In Produktion“ verlangt).
5. **Zielgruppe → App veröffentlichen** (Produktionsmodus), damit der Login nicht nach 7 Tagen abläuft. Keine Prüfung durch Google nötig; beim Login erscheint nur „nicht verifizierte App“ (Erweitert → Weiter).
6. **Anmeldedaten → Anmeldedaten erstellen → OAuth-Client-ID → Anwendungstyp „Webanwendung“** (nicht „Desktop“!). Bei „Autorisierte JavaScript-Quellen“ die spätere Hosting-Adresse eintragen (siehe Schritt 3), z. B. `https://dein-name.github.io`, plus `http://localhost:3111` für lokale Tests.
7. Die entstandene **Client-ID** (endet auf `.apps.googleusercontent.com`) in [public/google-config.js](public/google-config.js) eintragen. Sie ist kein Geheimnis, darf im Quelltext stehen.

### 2. Kalender anlegen

In Google Kalender einen neuen Kalender „Haus-Tasks“ anlegen (⊕ neben „Andere Kalender“ → „Neuen Kalender erstellen“). Unter dessen Einstellungen → „Kalender integrieren“ die **Kalender-ID** notieren (Format `xxxxx@group.calendar.google.com`) – die brauchst du gleich beim ersten Öffnen der App.

### 3. Hosting

Die App besteht nur aus statischen Dateien (kein Node-Server nötig). Den Ordner `public/` irgendwo mit einer festen HTTPS-Adresse veröffentlichen, zum Beispiel:

- **GitHub Pages** (kostenlos, dauerhaft): Repo auf GitHub anlegen, `public/`-Inhalt hineinlegen, unter „Settings → Pages“ aktivieren.
- **Netlify Drop** (https://app.netlify.com/drop, kostenlos, kein Konto für einen ersten Test nötig): den `public/`-Ordner per Drag-and-drop hochladen.

Die entstandene Adresse als „Autorisierte JavaScript-Quelle“ beim OAuth-Client (Schritt 1.6) ergänzen, falls noch nicht geschehen.

### 4. Erste Anmeldung

Die gehostete Adresse öffnen → „Mit Google anmelden“ → die Kalender-ID aus Schritt 2 eintragen. Fertig – Tasks landen ab jetzt im geteilten Kalender.

## Weitere Haushaltsmitglieder einladen

Oben rechts auf das **⚙** tippen → „👪 Haushalt einladen“ (oder `/haushalt.html` öffnen). Die Seite führt durch:
1. Den Kalender „Haus-Tasks“ direkt in Google Kalender für die Person freigeben (Berechtigung „Änderungen an Terminen vornehmen“).
2. Eine vorformulierte Nachricht mit Link zum Weiterschicken.
3. Einen QR-Code mit demselben Link (samt Kalender-ID), praktisch zum direkten Scannen.

Die Person öffnet den Link, meldet sich mit ihrem **eigenen** Google-Konto an (nicht deinem) und ist sofort startklar – die Kalender-ID kommt automatisch aus dem Link.

**Wichtig:** Die App hat keinen eigenen Login über das Google-Konto hinaus. Wer Zugriff auf den Kalender hat, kann alle Tasks sehen, bearbeiten und löschen.

## Offline & Sync

Jedes Gerät speichert im Browser (IndexedDB) und synct direkt mit Google:

- **Automatisch:** beim Öffnen, beim Wiederverbinden, beim Zurückwechseln zur App, alle 5 Minuten und sofort nach jeder eigenen Änderung (sofern erreichbar).
- **Manuell:** ⚙ oben rechts → „Jetzt synchronisieren“. Der kleine Punkt am Zahnrad zeigt den Stand (grau = unbekannt/nicht erreichbar, grün = in Ordnung, rot = Fehler); der Text dazu steht im Dialog, ohne Verbindung z. B. „Nicht erreichbar · N Änderung(en) warten“ statt eines Fehlers.
- **Konflikte:** Ändern zwei Geräte gleichzeitig unterschiedliche Felder desselben Tasks, bleiben beide Änderungen erhalten (siehe oben). Bei einer Meldung wie „Bei „X“ gab es während der Offline-Zeit auch eine Änderung“ ist nichts verloren gegangen, das ist nur ein Hinweis.
- **Serien:** Der Folgetermin entsteht ausschließlich auf dem Gerät, auf dem tatsächlich abgehakt wurde (verhindert doppelte Folgetermine). Wird direkt in Googles eigener Oberfläche „✓ “ vor den Titel geschrieben, wird das übernommen, aber die Serie läuft dann nicht automatisch weiter – dafür die App verwenden.
- **Anmeldung:** Der Zugriffstoken läuft nach etwa einer Stunde ab und erneuert sich meist unbemerkt im Hintergrund, solange die Google-Sitzung im Browser aktiv ist. Ein echter, dauerhafter Login ganz ohne eigenen Server würde ein Google-Client-Secret im öffentlichen Quelltext erfordern (geprüft, siehe `public/auth.js`) – bewusst nicht gemacht. Falls doch mal eine sichtbare erneute Anmeldung nötig ist, merkt sich die App das zuletzt genutzte Konto (`public/google-config.js`s `email`-Scope), sodass dabei nur noch „Zulassen“ statt Kontoauswahl nötig ist.
- **Anmeldung beim Start (besonders mobil):** `boot()` versucht beim Öffnen immer zuerst eine stille Erneuerung (`Auth.getToken()`), statt nur auf den zwischengespeicherten Zeitstempel zu schauen – der ist nach einer Stunde abgelaufen, auch wenn man eigentlich noch angemeldet wäre. Das trifft vor allem auf dem Handy häufig zu, weil die App dort (als installierte Web-App) nach dem Schließen oft komplett neu startet statt nur im Hintergrund zu liegen. Ein reines Verbindungsproblem beim Start (z. B. kein Netz) zählt dabei nicht als Abmeldung – dann bleibt der zwischengespeicherte Stand sichtbar, ganz ohne erzwungenen Login.

**Einschränkung bei komplett kaltem Start ohne jede Verbindung** (Flugmodus, App-Symbol antippen): Ein Service Worker lässt die Seite selbst laden, auch ganz ohne Verbindung – das funktioniert zuverlässig, weil die Seite über HTTPS gehostet ist (anders als früher über eine reine Tailscale-Adresse). Bricht die Verbindung erst *während* die Seite schon offen ist, funktioniert ohnehin alles normal wie oben beschrieben.

## Tests

```
npm test
```

Die Kernlogik (Serien, Listen, Sync-Algorithmus inklusive Mehrgeräte-Szenarien, Google-API-Zugriff) ist mit Attrappen getestet, ganz ohne echte Google-Verbindung.

## Hinweise

- Farben sind Googles 11 Event-Farben. Graphit ist für „erledigt“ reserviert.
- Events, die du direkt im Kalender „Haus-Tasks“ anlegst, werden als Task übernommen (ohne Kategorie/Ort, die kennt Google ja nicht). Wiederkehrende Google-Events (Googles eigene „Wiederholen“-Funktion) und Events mit Uhrzeit werden ignoriert.
- Der versteckte Eintrag „⚙️ Haus-Tasks Einstellungen“ auf dem 1.1.1970 trägt die gemeinsame Listen- und Einstellungsdaten – nicht löschen oder bearbeiten.
- Tasks ohne Datum bekommen ebenfalls einen (nicht öffentlich sichtbaren) Termin auf dem 1.1.1970, sonst würden sie nie zu Google übertragen und blieben auf das eine Gerät beschränkt, auf dem sie angelegt wurden. Solche Termine ebenfalls nicht direkt in Google bearbeiten oder löschen.
- Wird ein datumsloser Task abgehakt, bekommt er automatisch das heutige Datum und wird dadurch zu einem ganz normalen, sichtbaren Google-Termin (statt weiter versteckt zu bleiben). Rückgängig machen lässt das Datum bewusst stehen.
- Für „Branding → Datenschutz/Startseite“ (falls Google das beim Veröffentlichen verlangt) reicht ein kurzer, öffentlich erreichbarer Text, z. B. als GitHub-Gist: kurz erklären, dass die App nur auf den Kalender „Haus-Tasks“ zugreift und keine Daten weitergibt.

## Frühere Variante: eigener PC-Server + Tailscale

Vor diesem Umbau lief die App als Node-Server auf einem PC, erreichbar fürs Handy über Tailscale
(`server.js`, `db.js`, `tasks.js`, `categories.js`, `locations.js`, `sync.js`, `gcal.js`, `auth.js` im
Projekt-Root, `scripts/`). Diese Dateien liegen weiterhin im Repo, werden von der aktuellen Oberfläche
aber nicht mehr verwendet. Falls du zu dieser Variante zurück willst oder sie parallel als Backup
brauchst, frag einfach danach – die Einrichtung dafür ist unter der Git-Historie dieser Datei
nachzulesen.
