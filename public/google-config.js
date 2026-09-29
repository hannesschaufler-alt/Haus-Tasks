// Öffentliche Google-Konfiguration dieser App. Eine OAuth-Client-ID ist kein Geheimnis (anders als ein
// Client-Secret) – sie darf hier im Klartext stehen, siehe Google-Dokumentation zu Web-Clients.
//
// Hier die Client-ID eintragen, die beim Anlegen des OAuth-Clients "Web-Anwendung" in der Google Cloud
// Console entsteht (siehe README, Abschnitt „Google einrichten“).
window.GOOGLE_CLIENT_ID = '1082182547900-t6lbg02spl1cg2vk5815g45n06723abt.apps.googleusercontent.com';

// Nur zum Lesen/Schreiben von Terminen auf Kalendern, auf die dieses Google-Konto Zugriff hat (eigene
// und geteilte) – bewusst nicht der volle "calendar"-Scope, der auch Kalender anlegen/löschen dürfte.
// "email" zusätzlich nur, damit sich die App die Konto-Adresse merken kann (siehe auth.js) – für einen
// evtl. nötigen erneuten Login als Vorschlag, spart dort die Kontoauswahl.
window.GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar.events email';
