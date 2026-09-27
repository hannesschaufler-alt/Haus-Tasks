const path = require('node:path');

// Für Tests per Umgebungsvariable auf ein Wegwerf-Verzeichnis umlenkbar.
const DATA_DIR = process.env.HAUS_TASKS_DATA || path.join(__dirname, 'data');

// Googles feste Event-Farben (colorId -> Name, Hex nur zur Anzeige in der App).
const COLORS = {
  1: { name: 'Lavendel', hex: '#a4bdfc' },
  2: { name: 'Salbei', hex: '#7ae7bf' },
  3: { name: 'Weintraube', hex: '#dbadff' },
  4: { name: 'Flamingo', hex: '#ff887c' },
  5: { name: 'Banane', hex: '#fbd75b' },
  6: { name: 'Mandarine', hex: '#ffb878' },
  7: { name: 'Pfau', hex: '#46d6db' },
  8: { name: 'Graphit', hex: '#9e9e9e' },
  9: { name: 'Heidelbeere', hex: '#5484ed' },
  10: { name: 'Basilikum', hex: '#51b749' },
  11: { name: 'Tomate', hex: '#dc2127' },
};

const CATEGORIES = {
  Elektrik: '5',
  Installation: '7',
  Innenausbau: '6',
  Möbel: '3',
  Garten: '10',
  Wartung: '9',
};

const LOCATIONS = ['Garten', 'Wohnraum', 'Küche', 'Sanitär', 'Halle', 'Keller', 'Dachboden'];
const PRIORITIES = ['hoch', 'mittel', 'niedrig'];

module.exports = {
  COLORS,
  CATEGORIES,
  LOCATIONS,
  PRIORITIES,
  DONE_COLOR: '8', // Graphit markiert erledigte Events in Google
  DONE_PREFIX: '✓ ',
  CALENDAR_NAME: 'Haus-Tasks',
  PORT: Number(process.env.HAUS_TASKS_PORT) || 3111,
  DATA_DIR,
  DB_FILE: path.join(DATA_DIR, 'haus-tasks.db'),
  CREDENTIALS_FILE: path.join(__dirname, 'credentials.json'),
  TOKEN_FILE: path.join(__dirname, 'token.json'),
  LOCK_FILE: path.join(DATA_DIR, 'sync.lock'),
};
