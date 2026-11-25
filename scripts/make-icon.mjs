// 生成 assets/logo.png（无第三方依赖，可重复执行）。
// 用法：node scripts/make-icon.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIZE = 256;
const RADIUS = 58;
const OUT = resolve(ROOT, "assets/logo.png");

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;

function roundedRectDistance(x, y, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(x - cx) - (halfW - r);
  const qy = Math.abs(y - cy) - (halfH - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - r;
}

function segmentDistance(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : clamp01(((x - ax) * dx + (y - ay) * dy) / len2);
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

// 白色「文」：一点、一横、两撇捺。
const DOT = { x: 128, y: 66, r: 9.5 };
const STROKE = 5.4;
const STROKES = [
  [84, 96, 172, 96],
  [94, 118, 164, 196],
  [164, 118, 94, 196],
];

const pixels = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const px = x + 0.5;
    const py = y + 0.5;

    // 圆角方形底：左上 #00A1D6 → 右下 #FB7299
    const bgMask = 1 - smooth(-0.8, 0.8, roundedRectDistance(px, py, SIZE / 2, SIZE / 2, SIZE / 2 - 10, SIZE / 2 - 10, RADIUS));
    const t = clamp01((px + py) / (SIZE * 2));
    const r = mix(0x00, 0xfb, t);
    const g = mix(0xa1, 0x72, t);
    const b = mix(0xd6, 0x99, t);

    // 白色字形覆盖率
    let glyph = 1 - smooth(-0.6, 0.6, Math.hypot(px - DOT.x, py - DOT.y) - DOT.r);
    for (const [ax, ay, bx, by] of STROKES) {
      const d = segmentDistance(px, py, ax, ay, bx, by) - STROKE;
      glyph = Math.max(glyph, 1 - smooth(-0.6, 0.6, d));
    }

    const i = (y * SIZE + x) * 4;
    pixels[i] = Math.round(mix(r, 255, glyph));
    pixels[i + 1] = Math.round(mix(g, 255, glyph));
    pixels[i + 2] = Math.round(mix(b, 255, glyph));
    pixels[i + 3] = Math.round(255 * bgMask);
  }
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0; // filter: none
  pixels.copy(raw, rowStart + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);
console.log(`logo.png ${SIZE}x${SIZE} -> ${OUT} (${(png.length / 1024).toFixed(1)} KiB)`);
