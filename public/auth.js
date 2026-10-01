// Google-Anmeldung im Browser über Google Identity Services (GIS) – läuft komplett ohne eigenen Server,
// bewusst passend für eine rein statisch gehostete Seite. Anders als bei der bisherigen Desktop-App gibt
// es hier keinen dauerhaften Refresh-Token: Der Zugriffstoken lebt ca. eine Stunde und wird erneuert,
// solange die Google-Sitzung im Browser aktiv ist – meist unbemerkt im Hintergrund, ohne erneute Anmeldung.
//
// Ein echter, serverlos dauerhafter Login (mit richtigem Refresh-Token) würde ein Google-Client-Secret im
// öffentlichen Quelltext erfordern (geprüft: ein "Desktop-App"-Client käme zwar ohne Secret aus, akzeptiert
// aber nur localhost-Adressen als Rücksprungziel, keine gehostete Seite) – bewusst nicht gewählt. Stattdessen
// zwei kleinere, serverlose Verbesserungen: das zuletzt genutzte Konto merken (spart bei einer nötigen
// erneuten Anmeldung die Kontoauswahl) und der Erneuerungsversuch etwas großzügiger vor Ablauf.
(function (root) {
  const STORAGE_KEY = 'haus-tasks-google-token';
  const HINT_KEY = 'haus-tasks-google-hint';
  let tokenClient = null;
  let current = loadStored(); // { access_token, expires_at } | null
  let hint = loadHint(); // zuletzt bekannte Konto-E-Mail, nur fürs schnellere erneute Anmelden
  const listeners = new Set();

  function loadStored() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const t = JSON.parse(raw);
      return t && t.expires_at > Date.now() ? t : null;
    } catch {
      return null;
    }
  }

  function loadHint() {
    try { return localStorage.getItem(HINT_KEY) || null; } catch { return null; }
  }

  function storeHint(email) {
    hint = email || null;
    try { if (email) localStorage.setItem(HINT_KEY, email); else localStorage.removeItem(HINT_KEY); } catch { /* ohne Speicherzugriff einfach nur im Speicher behalten */ }
  }

  // Best-effort, blockiert nichts: die Mail-Adresse dient nur als login_hint für einen künftigen, evtl.
  // nötigen sichtbaren Login – ohne sie muss man dort erst wieder das Konto aus der Liste auswählen.
  async function refreshHint(accessToken) {
    try {
      const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) return;
      const info = await res.json();
      if (info.email) storeHint(info.email);
    } catch { /* kein Problem, betrifft nur den Komfort beim nächsten Login */ }
  }

  function store(token) {
    current = token;
    try {
      if (token) localStorage.setItem(STORAGE_KEY, JSON.stringify(token));
      else localStorage.removeItem(STORAGE_KEY);
    } catch { /* z. B. privater Modus ohne Speicherzugriff: einfach nur im Speicher behalten */ }
    listeners.forEach((cb) => cb(!!token));
  }

  function loadGis() {
    if (root.google?.accounts?.oauth2) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Google-Anmeldedienst konnte nicht geladen werden (keine Verbindung?)'));
      document.head.append(s);
    });
  }

  async function ensureClient() {
    await loadGis();
    if (tokenClient) return tokenClient;
    if (!root.GOOGLE_CLIENT_ID || root.GOOGLE_CLIENT_ID.includes('HIER-DEINE')) {
      throw new Error('Google-Client-ID fehlt noch (google-config.js).');
    }
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: root.GOOGLE_CLIENT_ID,
      scope: root.GOOGLE_SCOPE,
      callback: () => {}, // wird pro Aufruf überschrieben, siehe requestToken()
    });
    return tokenClient;
  }

  function requestToken(promptMode) {
    return new Promise((resolve, reject) => {
      tokenClient.callback = (resp) => {
        if (resp.error) return reject(new Error(resp.error_description || resp.error));
        const token = { access_token: resp.access_token, expires_at: Date.now() + (Number(resp.expires_in) || 3000) * 1000 };
        store(token);
        refreshHint(token.access_token);
        resolve(token);
      };
      tokenClient.requestAccessToken(hint ? { prompt: promptMode, login_hint: hint } : { prompt: promptMode });
    });
  }

  // Meldet an (mit Google-Auswahlbildschirm, falls nötig). Muss von einer echten Nutzer-Interaktion
  // (Klick) aus aufgerufen werden, sonst blockieren Browser das Pop-up.
  async function signIn() {
    await ensureClient();
    return requestToken('consent');
  }

  function signOut() {
    if (current?.access_token && root.google?.accounts?.oauth2) {
      google.accounts.oauth2.revoke(current.access_token, () => {});
    }
    store(null);
    storeHint(null); // explizites Abmelden: nicht das nächste Mal ein evtl. falsches Konto vorschlagen
  }

  // Liefert einen gültigen Zugriffstoken, erneuert ihn bei Bedarf im Hintergrund. Wirft, wenn dafür eine
  // erneute, sichtbare Anmeldung nötig wäre (z. B. Zugriff wurde bei Google widerrufen) – die Oberfläche
  // zeigt dann wieder den Anmelde-Button. Die 5-Minuten-Schwelle (statt erst kurz vor Ablauf) gibt der
  // stillen Erneuerung etwas Luft, bevor der Token wirklich abgelaufen ist.
  //
  // Wichtig: fehlt gerade die Verbindung (häufig auf dem Handy – Mobilfunk-Wechsel, schwaches Netz),
  // ist das kein „abgemeldet“, sondern nur vorübergehend nicht erreichbar – der gespeicherte Token
  // bleibt dafür unangetastet, authRequired wird nur bei einer tatsächlichen Ablehnung durch Google
  // gesetzt. Sonst würde jeder kurze Verbindungsaussetzer wie ein Logout aussehen.
  async function getToken() {
    if (current && current.expires_at > Date.now() + 5 * 60 * 1000) return current.access_token;
    if (!navigator.onLine) {
      throw Object.assign(new Error('Keine Verbindung – Zugriffstoken kann gerade nicht erneuert werden.'), { offline: true });
    }
    await ensureClient();
    try {
      return (await requestToken('')).access_token; // '' = versucht es zunächst still, ohne Pop-up
    } catch (e) {
      store(null);
      throw Object.assign(new Error('Bei Google abgemeldet oder Zugriff entzogen – bitte neu anmelden.'), { authRequired: true });
    }
  }

  function isSignedIn() {
    return !!current;
  }

  // Ob dieses Gerät sich schon mal angemeldet hatte, unabhängig davon, ob der Zugriffstoken gerade (nach
  // Uhrzeit) abgelaufen ist – anders als isSignedIn() bleibt das auch nach Ablauf wahr, bis zu einer
  // echten Abmeldung oder einer tatsächlichen Ablehnung durch Google. Für boot(): ganz ohne Verbindung
  // lieber die zwischengespeicherte Ansicht zeigen als sofort den vollen Anmelde-Bildschirm.
  function hasEverSignedIn() {
    try { return !!localStorage.getItem(STORAGE_KEY); } catch { return false; }
  }

  function onChange(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  root.Auth = { signIn, signOut, getToken, isSignedIn, hasEverSignedIn, onChange };
})(window);
