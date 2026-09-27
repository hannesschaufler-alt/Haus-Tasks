const fs = require('node:fs');
const { OAuth2Client } = require('google-auth-library');
const { calendar_v3 } = require('@googleapis/calendar');
const { CREDENTIALS_FILE, TOKEN_FILE, CALENDAR_NAME } = require('./config');
const { getMeta, setMeta } = require('./db');

// Darf sekundäre Kalender anlegen und darin Events verwalten, mehr nicht.
const SCOPES = ['https://www.googleapis.com/auth/calendar.app.created'];

class NotConnectedError extends Error {}

function readCredentials() {
  if (!fs.existsSync(CREDENTIALS_FILE)) {
    throw new NotConnectedError('credentials.json fehlt (siehe README, Schritt Google-Cloud).');
  }
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
  const c = raw.installed || raw.web;
  if (!c) throw new NotConnectedError('credentials.json hat ein unerwartetes Format.');
  return c;
}

function newClient(redirectUri) {
  const c = readCredentials();
  return new OAuth2Client(c.client_id, c.client_secret, redirectUri || c.redirect_uris?.[0]);
}

function isConnected() {
  if (process.env.HAUS_TASKS_NO_GOOGLE) return false; // für Tests: nie echte Google-Daten anfassen
  return fs.existsSync(CREDENTIALS_FILE) && fs.existsSync(TOKEN_FILE);
}

function authedClient() {
  const client = newClient(); // meldet fehlende credentials.json zuerst
  if (!fs.existsSync(TOKEN_FILE)) throw new NotConnectedError('Noch nicht bei Google angemeldet (npm run auth).');
  const tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  client.setCredentials(tokens);
  // Erneuerte Access-Tokens speichern, den Refresh-Token dabei behalten.
  client.on('tokens', (t) => {
    const merged = { ...tokens, ...t };
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(merged, null, 2));
  });
  return client;
}

function api() {
  return new calendar_v3.Calendar({ auth: authedClient() });
}

async function ensureCalendar(cal) {
  const known = getMeta('calendar_id');
  if (known) return known;

  try {
    const list = await cal.calendarList.list();
    const found = (list.data.items || []).find((c) => c.summary === CALENDAR_NAME);
    if (found) {
      setMeta('calendar_id', found.id);
      return found.id;
    }
  } catch (e) {
    // Der eingeschränkte Scope erlaubt evtl. kein Auflisten, dann wird direkt angelegt.
  }
  const created = await cal.calendars.insert({
    requestBody: { summary: CALENDAR_NAME, description: 'Automatisch von der Haus-Tasks-App verwaltet', timeZone: 'Europe/Berlin' },
  });
  setMeta('calendar_id', created.data.id);
  return created.data.id;
}

module.exports = { SCOPES, NotConnectedError, newClient, isConnected, api, ensureCalendar };
