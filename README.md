# Haus-Tasks

Aufgabenverwaltung für Haus und Garten, direkt zwischen allen Geräten synchronisiert über einen
**geteilten Google-Kalender** – ganz ohne eigenen Server. Jedes Gerät (PC, Handy) hat seine eigene
Installation (eine statisch gehostete Seite), meldet sich mit dem eigenen Google-Konto an und
synchronisiert direkt mit Google. Kategorie, Ort, Zuständigkeit, Priorität, Notizen, Checkliste und Serie
stecken dabei versteckt in jedem Kalendertermin mit (Google selbst zeigt nur Titel, Datum und Farbe an).

- **Offline-fähig:** Anlegen, Bearbeiten, Abhaken, Löschen funktionieren immer, auch ohne Verbindung. Sync automatisch oder per Knopfdruck, siehe „Offline & Sync“ unten
- Serien legen den Folgetermin erst beim Abhaken an, berechnet ab dem alten Fälligkeitsdatum. Rhythmus wählbar: alle n Wochen, Monate oder Jahre, n-ter Wochentag im Monat, Tag x im Monat
- Checkliste pro Task („Sub-Tasks light“): Punkte im Formular anlegen, in der Übersicht über das Badge „☑ 2/5“ aufklappen und direkt abhaken
- Eigene Kategorien und Orte, geteilt über alle Geräte
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

Oben rechts auf **👪** klicken (oder `/haushalt.html` öffnen). Die Seite führt durch:
1. Den Kalender „Haus-Tasks“ direkt in Google Kalender für die Person freigeben (Berechtigung „Änderungen an Terminen vornehmen“).
2. Eine vorformulierte Nachricht mit Link zum Weiterschicken.
3. Einen QR-Code mit demselben Link (samt Kalender-ID), praktisch zum direkten Scannen.

Die Person öffnet den Link, meldet sich mit ihrem **eigenen** Google-Konto an (nicht deinem) und ist sofort startklar – die Kalender-ID kommt automatisch aus dem Link.

**Wichtig:** Die App hat keinen eigenen Login über das Google-Konto hinaus. Wer Zugriff auf den Kalender hat, kann alle Tasks sehen, bearbeiten und löschen.

## Offline & Sync

Jedes Gerät speichert im Browser (IndexedDB) und synct direkt mit Google:

- **Automatisch:** beim Öffnen, beim Wiederverbinden, beim Zurückwechseln zur App, alle 5 Minuten und sofort nach jeder eigenen Änderung (sofern erreichbar).
- **Manuell:** der Sync-Button oben rechts. Ohne Verbindung zeigt die Kopfzeile „Nicht erreichbar · N Änderung(en) warten“ statt eines Fehlers.
- **Konflikte:** Ändern zwei Geräte gleichzeitig unterschiedliche Felder desselben Tasks, bleiben beide Änderungen erhalten (siehe oben). Bei einer Meldung wie „Bei „X“ gab es während der Offline-Zeit auch eine Änderung“ ist nichts verloren gegangen, das ist nur ein Hinweis.
- **Serien:** Der Folgetermin entsteht ausschließlich auf dem Gerät, auf dem tatsächlich abgehakt wurde (verhindert doppelte Folgetermine). Wird direkt in Googles eigener Oberfläche „✓ “ vor den Titel geschrieben, wird das übernommen, aber die Serie läuft dann nicht automatisch weiter – dafür die App verwenden.
- **Anmeldung:** Der Zugriffstoken läuft nach etwa einer Stunde ab und erneuert sich meist unbemerkt im Hintergrund, solange die Google-Sitzung im Browser aktiv ist. Nur wenn der Zugriff bei Google widerrufen wurde, erscheint wieder der Anmelde-Bildschirm.

**Einschränkung bei komplett kaltem Start ohne jede Verbindung** (Flugmodus, App-Symbol antippen): Ein Service Worker lässt die Seite selbst laden, auch ganz ohne Verbindung – das funktioniert zuverlässig, weil die Seite über HTTPS gehostet ist (anders als früher über eine reine Tailscale-Adresse). Bricht die Verbindung erst *während* die Seite schon offen ist, funktioniert ohnehin alles normal wie oben beschrieben.

## Tests

```
npm test
```

Die Kernlogik (Serien, Kategorien/Orte, Sync-Algorithmus inklusive Mehrgeräte-Szenarien, Google-API-Zugriff) ist mit Attrappen getestet, ganz ohne echte Google-Verbindung.

## Hinweise

- Farben sind Googles 11 Event-Farben. Graphit ist für „erledigt“ reserviert.
- Events, die du direkt im Kalender „Haus-Tasks“ anlegst, werden als Task übernommen (ohne Kategorie/Ort, die kennt Google ja nicht). Wiederkehrende Google-Events (Googles eigene „Wiederholen“-Funktion) und Events mit Uhrzeit werden ignoriert.
- Der versteckte Eintrag „⚙️ Haus-Tasks Einstellungen“ auf dem 1.1.1970 trägt die gemeinsame Kategorien-/Orte-Liste – nicht löschen oder bearbeiten.
- Tasks ohne Datum bekommen ebenfalls einen (nicht öffentlich sichtbaren) Termin auf dem 1.1.1970, sonst würden sie nie zu Google übertragen und blieben auf das eine Gerät beschränkt, auf dem sie angelegt wurden. Solche Termine ebenfalls nicht direkt in Google bearbeiten oder löschen.
- Für „Branding → Datenschutz/Startseite“ (falls Google das beim Veröffentlichen verlangt) reicht ein kurzer, öffentlich erreichbarer Text, z. B. als GitHub-Gist: kurz erklären, dass die App nur auf den Kalender „Haus-Tasks“ zugreift und keine Daten weitergibt.

## Frühere Variante: eigener PC-Server + Tailscale

Vor diesem Umbau lief die App als Node-Server auf einem PC, erreichbar fürs Handy über Tailscale
(`server.js`, `db.js`, `tasks.js`, `categories.js`, `locations.js`, `sync.js`, `gcal.js`, `auth.js` im
Projekt-Root, `scripts/`). Diese Dateien liegen weiterhin im Repo, werden von der aktuellen Oberfläche
aber nicht mehr verwendet. Falls du zu dieser Variante zurück willst oder sie parallel als Backup
brauchst, frag einfach danach – die Einrichtung dafür ist unter der Git-Historie dieser Datei
nachzulesen.
