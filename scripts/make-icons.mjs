// Draws icons/icon{16,32,48,128}.png: a blue rounded square with a white arrow jumping over a line.
// Dependency-free (zlib PNG encoder, 4x4 supersampling). Usage: node scripts/make-icons.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../icons/', import.meta.url));
const BG = [9, 105, 218];
const FG = [255, 255, 255];

// Shapes in a 0..1 unit square. Returns 'fg', 'bg' or null (transparent).
function shade(x, y) {
  const r = 0.2;
  const cx = Math.min(Math.max(x, r), 1 - r), cy = Math.min(Math.max(y, r), 1 - r);
  if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return null;
  // Baseline (the "code" being jumped over)
  if (y > 0.72 && y < 0.8 && x > 0.18 && x < 0.82) return 'fg';
  // Arc from bottom-left up and over to the right
  const ax = 0.42, ay = 0.6, R = 0.28, w = 0.065;
  const d = Math.hypot(x - ax, y - ay);
  if (y < ay - 0.06 && Math.abs(d - R) < w) return 'fg';
  // Arrow head pointing down at the arc's right end
  const tipY = 0.7, baseY = 0.5, half = 0.15;
  if (y > baseY && y < tipY && Math.abs(x - (ax + R)) < half * (tipY - y) / (tipY - baseY)) return 'fg';
  return 'bg';
}

function png(size) {
  const S = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let fg = 0, bg = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const s = shade((px + (sx + 0.5) / S) / size, (py + (sy + 0.5) / S) / size);
        if (s === 'fg') fg++; else if (s === 'bg') bg++;
      }
      const a = fg + bg;
      const o = py * (size * 4 + 1) + 1 + px * 4;
      for (let c = 0; c < 3; c++) raw[o + c] = a ? Math.round((FG[c] * fg + BG[c] * bg) / a) : 0;
      raw[o + 3] = Math.round((255 * a) / (S * S));
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(out, { recursive: true });
for (const size of [16, 32, 48, 128]) fs.writeFileSync(`${out}icon${size}.png`, png(size));
