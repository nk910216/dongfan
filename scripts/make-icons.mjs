import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Draws the home screen icons.
 *
 * Written out rather than pulled in as a dependency, and committed rather
 * than generated on every build: they change when the app is renamed and
 * at no other time, and a build that silently rewrites binary files is a
 * diff nobody reads.
 *
 * A manifest without real PNGs is why an install prompt never appears, and
 * why iOS falls back to a screenshot of the page. Both sizes are required
 * (spec 9.6).
 */

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../packages/web/public');

/** The app's own colours, from index.css. */
const GROUND = [0x13, 0x11, 0x0e];
const ACCENT = [0xe8, 0xb1, 0x5c];
const LEAF = [0x74, 0xd3, 0x9a];

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** `paint(x, y)` returns [r, g, b] for one pixel. */
function png(size, paint) {
  const stride = size * 3;
  const raw = Buffer.alloc((stride + 1) * size);

  for (let y = 0; y < size; y += 1) {
    // One filter byte per scanline; 0 means the row is stored as-is.
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b] = paint(x, y);
      const at = y * (stride + 1) + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;  // bits per channel
  header[9] = 2;  // truecolour, no alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A sprout on a dark square, which is the avatar the home screen already
 * uses. Opaque to the edges: a maskable icon is cropped to whatever shape
 * the platform likes, and transparent corners come back as black ones.
 */
function draw(size) {
  const centre = size / 2;
  const stem = Math.max(2, Math.round(size * 0.035));

  return (x, y) => {
    const dx = x - centre;
    const dy = y - centre;

    // The disc the sprout sits on, inset enough to survive a circular mask.
    if (Math.hypot(dx, dy) < size * 0.30) {
      // Stem.
      if (Math.abs(dx) <= stem && dy > -size * 0.02 && dy < size * 0.18) return LEAF;
      // Two leaves, as circles either side of the top of the stem.
      const leaf = size * 0.105;
      if (Math.hypot(dx + leaf, dy + leaf * 0.55) < leaf) return LEAF;
      if (Math.hypot(dx - leaf, dy + leaf * 0.55) < leaf) return LEAF;
      return GROUND;
    }

    return ACCENT;
  };
}

mkdirSync(OUT, { recursive: true });
for (const size of [192, 512]) {
  writeFileSync(resolve(OUT, `icon-${size}.png`), png(size, draw(size)));
  console.log(`icon-${size}.png`);
}
// iOS ignores the manifest for the home screen image and looks for this.
writeFileSync(resolve(OUT, 'apple-touch-icon.png'), png(180, draw(180)));
console.log('apple-touch-icon.png');
