// Erzeugt die App-Symbole (weißes Haus auf blauem Grund) als PNG, ohne Zusatzpakete: node scripts/make-icons.js
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BG = [47, 111, 237];
const FG = [255, 255, 255];

// Farbe an einem Punkt in 0..1-Koordinaten. Das Motiv bleibt in der mittleren Fläche (sicher für runde Masken).
function colorAt(x, y) {
  const inRoof = y >= 0.22 && y <= 0.5 && Math.abs(x - 0.5) <= ((y - 0.22) / 0.28) * 0.3;
  const inBody = x >= 0.29 && x <= 0.71 && y >= 0.48 && y <= 0.78;
  const inDoor = x >= 0.44 && x <= 0.56 && y >= 0.6 && y <= 0.78;
  if (inDoor) return BG;
  return inRoof || inBody ? FG : BG;
}

// `zoom` > 1 vergrößert das Motiv (Favicons haben wenig Platz und brauchen keinen Maskenrand).
function png(size, zoom = 1) {
  const rows = Buffer.alloc(size * (size * 3 + 1));
  const N = 3; // 3×3 Unterabtastung glättet die Kanten
  for (let py = 0; py < size; py++) {
    rows[py * (size * 3 + 1)] = 0; // Filter „keiner“
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < N; sy++) for (let sx = 0; sx < N; sx++) {
        const x = (px + (sx + 0.5) / N) / size;
        const y = (py + (sy + 0.5) / N) / size;
        const c = colorAt((x - 0.5) / zoom + 0.5, (y - 0.5) / zoom + 0.5);
        r += c[0]; g += c[1]; b += c[2];
      }
      const o = py * (size * 3 + 1) + 1 + px * 3;
      rows[o] = Math.round(r / (N * N));
      rows[o + 1] = Math.round(g / (N * N));
      rows[o + 2] = Math.round(b / (N * N));
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8 Bit, RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const dir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(dir, { recursive: true });
for (const [file, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  fs.writeFileSync(path.join(dir, file), png(size));
  console.log('geschrieben:', file);
}

// Favicon: größeres Motiv, als PNG und als .ico (mehrere Größen, PNG-Daten eingebettet) für Browser ohne SVG-Unterstützung.
const FAVICON_ZOOM = 1.45;
fs.writeFileSync(path.join(dir, 'favicon-32.png'), png(32, FAVICON_ZOOM));
console.log('geschrieben: favicon-32.png');

const sizes = [16, 32, 48];
const images = sizes.map((s) => png(s, FAVICON_ZOOM));
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2); // Typ: Symbol
header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const entries = sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e[0] = s; e[1] = s;
  e.writeUInt16LE(1, 4); // Farbebenen
  e.writeUInt16LE(24, 6); // Bit pro Pixel
  e.writeUInt32LE(images[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += images[i].length;
  return e;
});
fs.writeFileSync(path.join(__dirname, '..', 'public', 'favicon.ico'), Buffer.concat([header, ...entries, ...images]));
console.log('geschrieben: favicon.ico');
