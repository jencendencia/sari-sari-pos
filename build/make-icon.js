// Turns the rendered icon page (build/icon.html) into src/icon.png.
//
// Chromium draws build/icon.html at 512 px and build/_icon-raw.png is that
// screenshot. This script decodes it, masks the corners with a rounded square
// so the tile sits on the taskbar with transparent corners, and re-encodes the
// PNG. Doing it here rather than in the page keeps the artwork full-bleed (no
// white page showing through) while still shipping a rounded icon.
//
//   node build/make-icon.js                 writes src/icon.png
//   node build/make-icon.js --sheet         also writes build/_icon-sheet.png
//   node build/make-icon.js --radius 0.22   corner radius as a fraction of the
//                                           side (default 0.215, ~modern grids)
//
// No image library: PNG decode and encode both use Node's built-in zlib.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const RAW = path.join(__dirname, '_icon-raw.png');
const OUT = path.join(__dirname, '..', 'src', 'icon.png');

/* ------------------------------------------------------------------ decode */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = -1;
  let interlaced = 0;
  const idat = [];
  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      interlaced = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + length;
  }
  if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`);
  if (interlaced) throw new Error('interlaced PNG is not supported');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      if (filter === 0) continue;
      if (filter === 1) line[x] = (line[x] + a) & 255;
      else if (filter === 2) line[x] = (line[x] + b) & 255;
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      } else throw new Error(`bad PNG filter ${filter}`);
    }
    for (let x = 0; x < width; x += 1) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      out[d] = line[s];
      out[d + 1] = line[s + 1];
      out[d + 2] = line[s + 2];
      out[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
    prev = line;
  }
  return { width, height, rgba: out };
}

/* -------------------------------------------------------------------- mask */
// Coverage of a rounded square over the png, supersampled so the corners stay
// smooth instead of stair-stepping.
function maskCorners({ width, height, rgba }, radiusFraction) {
  const radius = radiusFraction * Math.min(width, height);
  const ss = 4;
  const samples = ss * ss;

  function insideRounded(x, y) {
    const inner = { x0: 0, y0: 0, x1: width, y1: height };
    const cx = Math.min(Math.max(x, inner.x0 + radius), inner.x1 - radius);
    const cy = Math.min(Math.max(y, inner.y0 + radius), inner.y1 - radius);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          if (insideRounded(x + (sx + 0.5) / ss, y + (sy + 0.5) / ss)) hits += 1;
        }
      }
      const coverage = hits / samples;
      const at = (y * width + x) * 4;
      rgba[at + 3] = Math.round(rgba[at + 3] * coverage);
    }
  }
  return { width, height, rgba };
}

/* -------------------------------------------------------------- downscale */
// Box filter: average each source block, which is honest for a review sheet.
function downscale({ width, height, rgba }, size) {
  const out = Buffer.alloc(size * size * 4);
  const scale = width / size;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = Math.floor(y * scale); sy < Math.floor((y + 1) * scale); sy += 1) {
        for (let sx = Math.floor(x * scale); sx < Math.floor((x + 1) * scale); sx += 1) {
          const at = (sy * width + sx) * 4;
          const alpha = rgba[at + 3] / 255;
          r += rgba[at] * alpha;
          g += rgba[at + 1] * alpha;
          b += rgba[at + 2] * alpha;
          a += alpha;
          n += 1;
        }
      }
      const at = (y * size + x) * 4;
      out[at] = a ? Math.round(r / a) : 0;
      out[at + 1] = a ? Math.round(g / a) : 0;
      out[at + 2] = a ? Math.round(b / a) : 0;
      out[at + 3] = Math.round((a / n) * 255);
    }
  }
  return { width: size, height: size, rgba: out };
}

/* ------------------------------------------------------------------ encode */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng({ width, height, rgba }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ sheet */
// The mark at the sizes Windows uses, on the app's own canvas and chrome, so a
// shape that only works at 512 px is caught before it ships.
function buildSheet(icon) {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pad = 14;
  const strip = 256 + pad * 2;
  const width = sizes.reduce((sum, s) => sum + s + pad, pad);
  const height = strip * 2;
  const out = Buffer.alloc(width * height * 4);
  const strips = [
    [237, 241, 240],
    [12, 43, 41],
  ];

  for (let row = 0; row < 2; row += 1) {
    const top = row * strip;
    for (let y = top; y < top + strip; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = (y * width + x) * 4;
        out[at] = strips[row][0];
        out[at + 1] = strips[row][1];
        out[at + 2] = strips[row][2];
        out[at + 3] = 255;
      }
    }
    let x = pad;
    for (const size of sizes) {
      const art = size === icon.width ? icon : downscale(icon, size);
      const y0 = top + pad + Math.floor((256 - size) / 2);
      for (let sy = 0; sy < size; sy += 1) {
        for (let sx = 0; sx < size; sx += 1) {
          const from = (sy * size + sx) * 4;
          const alpha = art.rgba[from + 3] / 255;
          if (!alpha) continue;
          const to = ((y0 + sy) * width + x + sx) * 4;
          for (let c = 0; c < 3; c += 1) out[to + c] = Math.round(out[to + c] * (1 - alpha) + art.rgba[from + c] * alpha);
        }
      }
      x += size + pad;
    }
  }
  return { width, height, rgba: out };
}

/* ------------------------------------------------------------------- main */
const radiusArg = process.argv.indexOf('--radius');
const radius = radiusArg === -1 ? 0.215 : Number(process.argv[radiusArg + 1]);
if (!fs.existsSync(RAW)) {
  console.error(`missing ${path.relative(process.cwd(), RAW)} — screenshot build/icon.html at 512 px first`);
  process.exit(1);
}

const icon = maskCorners(decodePng(fs.readFileSync(RAW)), radius);
const png = encodePng(icon);
fs.writeFileSync(OUT, png);
console.log(`wrote ${path.relative(process.cwd(), OUT)} — ${icon.width}x${icon.height}, ${png.length} bytes`);

if (process.argv.includes('--sheet')) {
  const sheet = buildSheet(icon);
  const sheetPath = path.join(__dirname, '_icon-sheet.png');
  fs.writeFileSync(sheetPath, encodePng(sheet));
  console.log(`wrote ${path.relative(process.cwd(), sheetPath)} — ${sheet.width}x${sheet.height}`);
}
