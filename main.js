const { app, BrowserWindow, ipcMain, dialog, protocol, net, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const yazl = require('yazl');
const yauzl = require('yauzl');

const UA = 'SariSariPOS/1.0 (desktop point of sale)';

// ---------------------------------------------------------------------------
// Custom protocol so the renderer can show stored pictures safely.
// ---------------------------------------------------------------------------
protocol.registerSchemesAsPrivileged([
  { scheme: 'img', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const IMAGE_TYPES = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/x-icon': '.ico',
};

function dataFile() {
  return path.join(app.getPath('userData'), 'sari-pos.json');
}

function pictureDir() {
  const dir = path.join(app.getPath('userData'), 'pictures');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Data store: a real SQLite database file.
//
// node-sqlite3-wasm is used instead of better-sqlite3 because this machine has
// no MSVC toolchain: it is actual SQLite compiled to WebAssembly, so it reads
// and writes a normal .db file with no native compilation.
// ---------------------------------------------------------------------------
const { Database } = require('node-sqlite3-wasm');

let db = null;

function dbFile() {
  return path.join(app.getPath('userData'), 'sari-pos.db');
}

function openDb() {
  if (db) return db;
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  db = new Database(dbFile());
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      barcode TEXT NOT NULL DEFAULT '',
      price REAL NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      original_price REAL NOT NULL DEFAULT 0,
      bundle_qty INTEGER NOT NULL DEFAULT 0,
      bundle_price REAL NOT NULL DEFAULT 0,
      stock INTEGER NOT NULL DEFAULT 0,
      low_stock INTEGER NOT NULL DEFAULT 5,
      image TEXT,
      hidden INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
    CREATE TABLE IF NOT EXISTS sales (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      items TEXT NOT NULL DEFAULT '[]',
      total REAL NOT NULL DEFAULT 0,
      paid REAL NOT NULL DEFAULT 0,
      change_due REAL NOT NULL DEFAULT 0,
      count INTEGER NOT NULL DEFAULT 0,
      voided INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      items TEXT NOT NULL DEFAULT '[]',
      total REAL NOT NULL DEFAULT 0,
      count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS change_fund (
      day TEXT PRIMARY KEY,
      amount REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT ''
    );
  `);
  // Databases created before the original price existed need the column added.
  const productColumns = db.all('PRAGMA table_info(products)');
  if (productColumns && !productColumns.some((c) => c.name === 'original_price')) {
    db.exec('ALTER TABLE products ADD COLUMN original_price REAL NOT NULL DEFAULT 0');
  }
  // Databases created before hiding an item existed need the column added.
  if (productColumns && !productColumns.some((c) => c.name === 'hidden')) {
    db.exec('ALTER TABLE products ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
  }
  // Databases created before the cost price existed need the column added.
  if (productColumns && !productColumns.some((c) => c.name === 'cost')) {
    db.exec('ALTER TABLE products ADD COLUMN cost REAL NOT NULL DEFAULT 0');
  }
  // Databases created before bundle offers ("3 for 5") need their columns too.
  if (productColumns && !productColumns.some((c) => c.name === 'bundle_qty')) {
    db.exec('ALTER TABLE products ADD COLUMN bundle_qty INTEGER NOT NULL DEFAULT 0');
  }
  if (productColumns && !productColumns.some((c) => c.name === 'bundle_price')) {
    db.exec('ALTER TABLE products ADD COLUMN bundle_price REAL NOT NULL DEFAULT 0');
  }
  // Profit is the selling price minus the "Original price" (what the shop paid),
  // so anything typed into the short-lived Cost price field is moved across
  // instead of being stranded under a name nothing reads any more.
  db.exec(
    'UPDATE products SET original_price = cost WHERE (original_price IS NULL OR original_price = 0) AND cost > 0'
  );
  // Databases created before voiding a sale existed need the column added.
  const saleColumns = db.all('PRAGMA table_info(sales)');
  if (saleColumns && !saleColumns.some((c) => c.name === 'voided')) {
    db.exec('ALTER TABLE sales ADD COLUMN voided INTEGER NOT NULL DEFAULT 0');
  }
  migrateLegacyJson();
  return db;
}

// Closing matters for restoring: the file cannot be swapped while SQLite still
// has it open, and the next openDb() then reads the file that is on disk.
function closeDb() {
  if (!db) return;
  try {
    db.close();
  } catch (err) {
    /* already closed, or never fully opened */
  }
  db = null;
}

// One-time import of the old JSON file, if the shop already had data.
function migrateLegacyJson() {
  const file = dataFile();
  if (!fs.existsSync(file)) return;
  let legacy = null;
  try {
    legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    legacy = null;
  }
  if (!legacy || typeof legacy !== 'object') return;

  const existing = db.get('SELECT (SELECT COUNT(*) FROM products) AS p, (SELECT COUNT(*) FROM sales) AS s');
  if (existing && (existing.p > 0 || existing.s > 0)) return; // database already in use

  try {
    db.exec('BEGIN');
    for (const p of Array.isArray(legacy.products) ? legacy.products : []) {
      const name = String(p && p.name ? p.name : '').trim();
      if (!name) continue;
      db.run(
        'INSERT INTO products (id, name, barcode, price, stock, low_stock, image, updated_at) VALUES (?,?,?,?,?,?,?,?)',
        [
          String(p.id || uid()),
          name,
          String(p.barcode || ''),
          Math.max(0, asNumber(p.price)),
          Math.max(0, Math.round(asNumber(p.stock))),
          Math.max(0, Math.round(asNumber(p.lowStock, 5))),
          p.image ? String(p.image) : null,
          p.updatedAt || new Date().toISOString(),
        ]
      );
    }
    for (const s of Array.isArray(legacy.sales) ? legacy.sales : []) {
      if (!s || !s.id) continue;
      db.run(
        'INSERT INTO sales (id, at, items, total, paid, change_due, count) VALUES (?,?,?,?,?,?,?)',
        [
          String(s.id),
          String(s.at || new Date().toISOString()),
          JSON.stringify(Array.isArray(s.items) ? s.items : []),
          Math.max(0, asNumber(s.total)),
          Math.max(0, asNumber(s.paid)),
          asNumber(s.change),
          Math.max(0, Math.round(asNumber(s.count))),
        ]
      );
    }
    const settings = legacy.settings && typeof legacy.settings === 'object' ? legacy.settings : {};
    putSetting('storeName', settings.storeName || 'My Sari-Sari Store');
    putSetting('lowStock', String(settings.lowStock == null ? 5 : Math.max(0, Math.round(asNumber(settings.lowStock, 5)))));
    db.exec('COMMIT');
  } catch (err) {
    console.error('[migrate]', err);
    try {
      db.exec('ROLLBACK');
    } catch (rollbackErr) {
      // nothing to roll back
    }
    return;
  }

  // Keep the old file as a backup instead of deleting it.
  try {
    fs.renameSync(file, file + '.migrated');
    console.log('[migrate] imported old data from', file);
  } catch (err) {
    console.error('[migrate] could not rename old file', err);
  }
}

// ---------------------------------------------------------------------------
// Row helpers: SQLite columns are snake_case, the app uses camelCase.
// ---------------------------------------------------------------------------
function rowToProduct(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    barcode: row.barcode,
    price: row.price,
    originalPrice: row.original_price || 0,
    bundleQty: row.bundle_qty || 0,
    bundlePrice: row.bundle_price || 0,
    stock: row.stock,
    lowStock: row.low_stock,
    image: row.image,
    hidden: !!row.hidden,
    updatedAt: row.updated_at,
  };
}

// A bundle offer is "how many in a set" plus "what the set costs" — 3 for 5.
// The set price is the figure the shop types and the unit price stored beside
// it is worked out from it, which is why there is no cheaper-than-singles test
// here: the bundle is the price, not a discount applied on top of one.
function cleanBundle(bundleQty, bundlePrice) {
  const qty = Math.round(asNumber(bundleQty));
  const setPrice = Math.round(asNumber(bundlePrice) * 10000) / 10000;
  if (qty < 2 || setPrice <= 0) return null;
  return { qty, price: setPrice };
}

// Whole bundles at the bundle price, the odd piece at the single price.
function lineTotal(line) {
  const price = Math.max(0, asNumber(line && line.price));
  const qty = Math.max(0, Math.round(asNumber(line && line.qty)));
  const offer = cleanBundle(line && line.bundleQty, line && line.bundlePrice);
  if (!offer) return price * qty;
  const groups = Math.floor(qty / offer.qty);
  return Math.round((groups * offer.price + (qty - groups * offer.qty) * price) * 100) / 100;
}

function rowToSale(row) {
  if (!row) return null;
  let items = [];
  try {
    items = JSON.parse(row.items);
  } catch (err) {
    items = [];
  }
  return {
    id: row.id,
    at: row.at,
    items,
    total: row.total,
    paid: row.paid,
    change: row.change_due,
    count: row.count,
    voided: !!row.voided,
  };
}

// A frozen sale: the cart parked so the shopkeeper can serve someone else.
function rowToHold(row) {
  if (!row) return null;
  let items = [];
  try {
    items = JSON.parse(row.items);
  } catch (err) {
    items = [];
  }
  return {
    id: row.id,
    at: row.at,
    label: row.label,
    items,
    total: row.total,
    count: row.count,
  };
}

function getSetting(key, fallback) {
  const row = db.get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : fallback;
}

function putSetting(key, value) {
  db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
    key,
    String(value),
  ]);
}

function readSettings() {
  return {
    storeName: getSetting('storeName', 'My Sari-Sari Store'),
    lowStock: Math.max(0, Math.round(asNumber(getSetting('lowStock', '5'), 5))),
  };
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// Pictures on disk
// ---------------------------------------------------------------------------
function sniffExtension(buf) {
  if (buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50) return '.png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
  if (buf.length > 3 && buf[0] === 0x47 && buf[1] === 0x49) return '.gif';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  if (buf.length > 4 && buf.toString('ascii', 0, 4) === '<svg'.toLowerCase()) return '.svg';
  if (buf.length > 200 && /^\s*<\?xml/.test(buf.toString('utf8', 0, 64))) return '.svg';
  return null;
}

function storePicture(buf, contentType) {
  if (buf.length > 25 * 1024 * 1024) {
    throw new Error('That picture is too big (over 25 MB).');
  }
  let ext = IMAGE_TYPES[(contentType || '').split(';')[0].trim().toLowerCase()];
  if (!ext) ext = sniffExtension(buf);
  if (!ext) throw new Error('That does not look like a picture file.');
  const name = 'pic-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7) + ext;
  fs.writeFileSync(path.join(pictureDir(), name), buf);
  return name;
}

function safePicturePath(filename) {
  const clean = path.basename(String(filename || ''));
  if (!clean || clean !== filename) return null;
  const full = path.join(pictureDir(), clean);
  if (!full.startsWith(pictureDir())) return null;
  return fs.existsSync(full) ? full : null;
}

// Internet access goes through Chromium's network stack (net.fetch), which
// follows the machine's real connectivity; Node's fetch can hang here.
async function httpBuffer(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const request = typeof net.fetch === 'function' ? net.fetch : fetch;
    const res = await request(url, {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
      signal: controller.signal,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      ok: res.ok,
      status: res.status,
      type: (res.headers.get('content-type') || '').split(';')[0].trim(),
      buf,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function httpJson(url, timeoutMs) {
  const { ok, status, buf } = await httpBuffer(url, timeoutMs);
  if (!ok) throw new Error('picture library answered ' + status);
  return JSON.parse(buf.toString('utf8'));
}

// Download one picture candidate and turn any failure into a short reason a
// shopkeeper can understand, instead of a raw network error.
async function fetchPictureCandidate(url) {
  let outcome;
  try {
    outcome = await httpBuffer(url, 30000);
  } catch (err) {
    const message = String((err && err.message) || err);
    const timedOut = (err && err.name === 'AbortError') || /abort|timed out|terminated/i.test(message);
    return { url, reason: timedOut ? 'it took too long' : 'no answer from the website' };
  }
  if (!outcome.ok) {
    return { url, status: outcome.status, reason: `the website answered ${outcome.status}` };
  }
  try {
    return { url, file: storePicture(outcome.buf, outcome.type) };
  } catch (err) {
    return { url, reason: String((err && err.message) || err).toLowerCase() };
  }
}

async function thumbToDataUrl(url) {
  if (!url) return null;
  try {
    const { ok, type, buf } = await httpBuffer(url, 8000);
    if (!ok || !type.startsWith('image/')) return null;
    if (buf.length === 0 || buf.length > 3 * 1024 * 1024) return null;
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch (err) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Picture search on the internet (no API key needed)
// ---------------------------------------------------------------------------
async function searchOpenverse(query) {
  const url =
    'https://api.openverse.org/v1/images/?q=' +
    encodeURIComponent(query) +
    '&page_size=12&mature=false';
  const json = await httpJson(url, 12000);
  const results = (json.results || [])
    .map((r) => ({ title: r.title || '', page: r.foreign_landing_url || '', url: r.url, thumb: r.thumbnail }))
    .filter((r) => r.url);
  if (!results.length) throw new Error('no pictures found');
  return Promise.all(
    results.map(async (r) => ({ ...r, thumbData: await thumbToDataUrl(r.thumb) }))
  );
}

async function searchWikimedia(query) {
  const url =
    'https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search' +
    '&gsrnamespace=6&gsrlimit=12&prop=imageinfo&iiprop=url%7Cmime&iiurlwidth=400&gsrsearch=' +
    encodeURIComponent(query);
  const json = await httpJson(url, 12000);
  const pages = Object.values((json.query && json.query.pages) || {});
  const results = pages
    .map((p) => {
      const info = (p.imageinfo || [])[0];
      if (!info || !info.url) return null;
      const mime = info.mime || '';
      if (mime && !mime.startsWith('image/')) return null;
      return { title: (p.title || '').replace(/^File:/, ''), page: '', url: info.url, thumb: info.thumburl || info.url };
    })
    .filter(Boolean);
  if (!results.length) throw new Error('no pictures found');
  return Promise.all(
    results.map(async (r) => ({ ...r, thumbData: await thumbToDataUrl(r.thumb) }))
  );
}

// ---------------------------------------------------------------------------
// Barcode lookup: free, keyless product databases.
// Order matters — food first (Open Food Facts), then cosmetics, then general
// household goods, and finally the broad UPC catalogue as a fallback.
// ---------------------------------------------------------------------------
const LOOKUP_FIELDS = 'code,status,product_name,product_name_en,brands,quantity,image_front_url,image_url';
const lookupCache = new Map();
const LOOKUP_CACHE_MS = 15 * 60 * 1000;

function safeJson(buf) {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (err) {
    return null;
  }
}

async function openFactsLookup(host, version, code) {
  const url =
    `https://world.${host}/api/${version}/product/` +
    encodeURIComponent(code) +
    '.json?fields=' +
    LOOKUP_FIELDS;
  const { ok, status, buf } = await httpBuffer(url, 15000);
  if (!ok) {
    if (status === 404) return null; // simply not in this catalogue
    throw new Error(host + ' answered ' + status);
  }
  const json = safeJson(buf);
  if (!json) throw new Error(host + ' sent an unreadable reply');
  const product = json.product;
  if (!product) return null;
  const name = String(product.product_name || product.product_name_en || '').trim();
  if (!name) return null;
  // Several picture links: the front picture first, then the generic one, so a
  // download can fall through to the next instead of failing outright.
  const images = [...new Set([product.image_front_url, product.image_url].filter(Boolean))];
  return {
    name,
    brand: String(product.brands || '').split(',')[0].trim(),
    size: String(product.quantity || '').trim(),
    image: images[0] || null,
    images,
  };
}

async function upcItemDbLookup(code, timeoutMs) {
  const url = 'https://api.upcitemdb.com/prod/trial/lookup?upc=' + encodeURIComponent(code);
  const { ok, status, buf } = await httpBuffer(url, timeoutMs || 15000);
  if (status === 400) return null; // that code is not in the catalogue
  if (!ok) throw new Error('UPC catalogue answered ' + status);
  const json = safeJson(buf);
  if (!json) throw new Error('UPC catalogue sent an unreadable reply');
  const item = Array.isArray(json.items) ? json.items[0] : null;
  const name = item && item.title ? String(item.title).trim() : '';
  if (!name) return null;
  const images = Array.isArray(item.images) ? item.images.filter(Boolean).slice(0, 3) : [];
  // Prices: prefer the list/SRP figure from an offer, then a live offer price,
  // then the lowest price ever recorded for this code. The catalogue leaves
  // `currency` empty for most records — its data is US retail, so it is read
  // as US dollars and converted before it ever reaches a peso field.
  const offers = Array.isArray(item.offers) ? item.offers.filter(Boolean) : [];
  const priced = offers.find((o) => Number(o.list_price) > 0) || offers.find((o) => Number(o.price) > 0);
  const price = Number(priced ? priced.list_price || priced.price : item.lowest_recorded_price) || 0;
  const currency = String((priced && priced.currency) || item.currency || 'USD').trim().toUpperCase() || 'USD';
  return {
    name,
    brand: String(item.brand || '').trim(),
    size: String(item.size || '').trim(),
    image: images[0] || null,
    images,
    price: price > 0 ? price : null,
    priceCurrency: price > 0 ? currency : null,
  };
}

// ---------------------------------------------------------------------------
// Peso conversion for an internet price. Cached for a day: a shopkeeper adding
// a shelf of products should not wait on a rate check for every barcode.
// ---------------------------------------------------------------------------
let rateCache = { at: 0, rate: 0 };

async function pesoRate() {
  if (rateCache.rate && Date.now() - rateCache.at < 24 * 60 * 60 * 1000) return rateCache.rate;
  const { ok, buf } = await httpBuffer('https://open.er-api.com/v6/latest/USD', 15000);
  if (!ok) throw new Error('the peso rate could not be checked');
  const json = safeJson(buf);
  const rate = json && json.rates ? Number(json.rates.PHP) : 0;
  if (!rate || !isFinite(rate)) throw new Error('the peso rate could not be checked');
  rateCache = { at: Date.now(), rate };
  return rate;
}

async function attachPesoPrice(result) {
  const price = Number(result.price);
  if (!price || price <= 0) return;
  const currency = String(result.priceCurrency || '').toUpperCase();
  if (currency === 'PHP') {
    result.pesoPrice = Math.round(price);
    result.priceSource = 'a peso price on the internet';
    return;
  }
  try {
    const rate = await pesoRate();
    result.pesoPrice = Math.round(price * rate);
    result.priceSource = `${currency || 'USD'} ${price.toFixed(2)} converted at ${rate.toFixed(1)}`;
  } catch (err) {
    // Keep the foreign figure so the screen can say what it did find.
    result.pesoPrice = null;
    result.priceSource = null;
    console.error('[barcode-price]', String((err && err.message) || err));
  }
}

ipcMain.handle('products:lookupBarcode', async (_event, rawCode) => {
  const code = String(rawCode || '').replace(/[\s-]/g, '');
  if (!/^\d{6,14}$/.test(code)) return null;

  const cached = lookupCache.get(code);
  if (cached && Date.now() - cached.at < LOOKUP_CACHE_MS) return cached.result;

  const steps = [
    () => openFactsLookup('openfoodfacts.org', 'v3', code),
    async () => {
      const found = await Promise.allSettled([
        openFactsLookup('openbeautyfacts.org', 'v2', code),
        openFactsLookup('openproductsfacts.org', 'v2', code),
      ]);
      for (const outcome of found) {
        if (outcome.status === 'fulfilled' && outcome.value) return outcome.value;
      }
      const failure = found.find((o) => o.status === 'rejected');
      if (failure) throw failure.reason;
      return null;
    },
    () => upcItemDbLookup(code),
  ];

  let result = null;
  let answered = 0;
  let lastProblem = null;
  let resultStep = -1;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    try {
      const found = await step();
      answered += 1;
      if (found) {
        result = found;
        resultStep = i;
        break;
      }
    } catch (err) {
      lastProblem = String((err && err.message) || err);
      console.error('[barcode-lookup]', lastProblem);
    }
  }

  if (!result && answered === 0) {
    // Nothing answered at all: do not cache it, so a retry can succeed.
    throw new Error('The internet could not be reached for this barcode.');
  }

  // The food and cosmetics catalogues carry no prices at all, so when one of
  // them supplied the name, ask the UPC catalogue only for a price — with a
  // short timeout, and quietly, because the name and picture already landed.
  if (result && !result.price && resultStep !== steps.length - 1) {
    try {
      const priced = await upcItemDbLookup(code, 6000);
      if (priced && priced.price) {
        result.price = priced.price;
        result.priceCurrency = priced.priceCurrency;
      }
    } catch (err) {
      console.error('[barcode-price]', String((err && err.message) || err));
    }
  }

  if (result) await attachPesoPrice(result);

  lookupCache.set(code, { at: Date.now(), result });
  if (lookupCache.size > 300) lookupCache.delete(lookupCache.keys().next().value);
  return result;
});

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    frame: false, // no native title bar: the app draws its own
    fullscreen: true, // fills the screen from edge to edge
    backgroundColor: '#E8EDF1',
    title: 'Sari-Sari POS',
    // Windows takes the taskbar icon from the window while the app runs
    // unpackaged; the packaged exe carries the same picture.
    icon: path.join(__dirname, 'src', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.removeMenu(); // no menu bar — every action lives in the three tabs
}

// The only window control the app offers: the ✕ in its own header.
ipcMain.on('window:close', () => {
  if (win && !win.isDestroyed()) win.close();
});

// The taskbar groups this app by this id and finds its icon through it, so it
// matches the appId the installer uses.
app.setAppUserModelId('com.jencendencia.sarisaripos');

app.whenReady().then(() => {
  protocol.handle('img', (request) => {
    try {
      const parsed = new URL(request.url);
      const file = safePicturePath(decodeURIComponent(parsed.pathname).replace(/^\//, ''));
      if (!file) return new Response('Not found', { status: 404 });
      const ext = path.extname(file).toLowerCase();
      const type =
        { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon' }[ext] || 'application/octet-stream';
      const buf = fs.readFileSync(file);
      return new Response(buf, { headers: { 'Content-Type': type, 'Cache-Control': 'max-age=86400' } });
    } catch (err) {
      return new Response('Not found', { status: 404 });
    }
  });

  Menu.setApplicationMenu(null); // no menu bar at all (renderer keeps working via its own buttons)
  openDb();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// Updates.
//
// The installed app asks the GitHub release whether a newer version exists.
// Nothing is downloaded until the shopkeeper presses the button, and the
// app installs it when it is closed. `npm start` has no update config, so a
// development copy says that plainly instead of failing in the background.
// ---------------------------------------------------------------------------
const { autoUpdater } = require('electron-updater');

autoUpdater.autoDownload = false; // the shopkeeper chooses when
autoUpdater.autoInstallOnAppQuit = true; // a downloaded update installs on close

function sendUpdateStatus(status, data) {
  if (win && !win.isDestroyed()) win.webContents.send('update:status', { status, data });
}

function updateError(err) {
  sendUpdateStatus('error', String((err && err.message) || err || 'Something went wrong while checking.'));
}

autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'));
autoUpdater.on('update-available', (info) => sendUpdateStatus('available', info || {}));
autoUpdater.on('update-not-available', (info) => sendUpdateStatus('not-available', info || {}));
autoUpdater.on('download-progress', (progress) => sendUpdateStatus('downloading', progress || {}));
autoUpdater.on('update-downloaded', (info) => sendUpdateStatus('downloaded', info || {}));
autoUpdater.on('error', updateError);

ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('update:check', async () => {
  if (!app.isPackaged) {
    sendUpdateStatus('error', 'This is a development copy. The installed app checks for updates.');
    return { ok: false };
  }
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (err) {
    updateError(err);
    return { ok: false };
  }
});

ipcMain.handle('update:download', async () => {
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (err) {
    updateError(err);
    return { ok: false };
  }
});

ipcMain.handle('update:install', () => {
  try {
    autoUpdater.quitAndInstall();
    return { ok: true };
  } catch (err) {
    updateError(err);
    return { ok: false };
  }
});

// ---------------------------------------------------------------------------
// Inventory IPC
// ---------------------------------------------------------------------------
ipcMain.handle('products:list', () => {
  const rows = openDb().all('SELECT * FROM products ORDER BY rowid');
  return rows.map(rowToProduct);
});

ipcMain.handle('products:findByBarcode', (_event, code) => {
  const needle = String(code || '').trim();
  if (!needle) return null;
  return rowToProduct(openDb().get('SELECT * FROM products WHERE barcode = ? LIMIT 1', [needle]));
});

ipcMain.handle('products:save', (_event, product) => {
  const conn = openDb();
  const name = String(product && product.name ? product.name : '').trim();
  if (!name) throw new Error('Please type the product name.');
  const settings = readSettings();
  const unitPrice = Math.max(0, asNumber(product.price));
  const offer = cleanBundle(product.bundleQty, product.bundlePrice);
  const record = {
    id: product.id || uid(),
    name,
    barcode: String(product.barcode || '').trim(),
    price: unitPrice,
    originalPrice: Math.max(0, asNumber(product.originalPrice)),
    bundleQty: offer ? offer.qty : 0,
    bundlePrice: offer ? offer.price : 0,
    stock: Math.max(0, Math.round(asNumber(product.stock))),
    lowStock: Math.max(0, Math.round(asNumber(product.lowStock, settings.lowStock))),
    image: product.image ? String(product.image) : null,
    updatedAt: new Date().toISOString(),
  };
  const found = conn.get('SELECT id, hidden FROM products WHERE id = ?', [record.id]);
  // A save that does not mention `hidden` (the product form, stock buttons)
  // must never unhide an item by accident, so it keeps whatever is stored.
  record.hidden =
    product && product.hidden !== undefined ? !!product.hidden : found ? !!found.hidden : false;
  const hiddenFlag = record.hidden ? 1 : 0;
  if (found) {
    conn.run(
      'UPDATE products SET name = ?, barcode = ?, price = ?, original_price = ?, bundle_qty = ?, bundle_price = ?, stock = ?, low_stock = ?, image = ?, hidden = ?, updated_at = ? WHERE id = ?',
      [record.name, record.barcode, record.price, record.originalPrice, record.bundleQty, record.bundlePrice, record.stock, record.lowStock, record.image, hiddenFlag, record.updatedAt, record.id]
    );
  } else {
    conn.run(
      'INSERT INTO products (id, name, barcode, price, original_price, bundle_qty, bundle_price, stock, low_stock, image, hidden, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [record.id, record.name, record.barcode, record.price, record.originalPrice, record.bundleQty, record.bundlePrice, record.stock, record.lowStock, record.image, hiddenFlag, record.updatedAt]
    );
  }
  return record;
});

ipcMain.handle('products:delete', (_event, id) => {
  const result = openDb().run('DELETE FROM products WHERE id = ?', [String(id || '')]);
  return result.changes > 0;
});

// ---------------------------------------------------------------------------
// Sales IPC
// ---------------------------------------------------------------------------
ipcMain.handle('sales:create', (_event, payload) => {
  const conn = openDb();
  const list = Array.isArray(payload && payload.items) ? payload.items : [];
  if (!list.length) throw new Error('There are no items in this sale.');

  const lines = [];
  for (const item of list) {
    const product = rowToProduct(conn.get('SELECT * FROM products WHERE id = ?', [String(item.id || '')]));
    if (!product) throw new Error('An item in the cart is no longer in the inventory.');
    const qty = Math.max(1, Math.round(asNumber(item.qty, 1)));
    const price = Math.max(0, asNumber(product.price));
    // The offer is frozen onto the line, so a receipt keeps reading the way the
    // customer paid even after the shop changes the prices.
    const offer = cleanBundle(product.bundleQty, product.bundlePrice);
    lines.push({
      id: product.id,
      name: product.name,
      price,
      originalPrice: Math.max(0, asNumber(product.originalPrice)),
      bundleQty: offer ? offer.qty : 0,
      bundlePrice: offer ? offer.price : 0,
      qty,
      image: product.image || null,
    });
    conn.run('UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ?', [qty, product.id]);
  }

  const total = Math.round(lines.reduce((sum, line) => sum + lineTotal(line), 0) * 100) / 100;
  const paid = Math.max(0, Math.round(asNumber(payload && payload.paid, total) * 100) / 100);
  const sale = {
    id: uid(),
    at: new Date().toISOString(),
    items: lines,
    total,
    paid,
    change: Math.round((paid - total) * 100) / 100,
    count: lines.reduce((sum, line) => sum + line.qty, 0),
  };
  conn.run(
    'INSERT INTO sales (id, at, items, total, paid, change_due, count) VALUES (?,?,?,?,?,?,?)',
    [sale.id, sale.at, JSON.stringify(sale.items), sale.total, sale.paid, sale.change, sale.count]
  );
  return sale;
});

ipcMain.handle('sales:list', (_event, limit) => {
  const max = Math.max(1, Math.min(2000, asNumber(limit, 500)));
  const rows = openDb().all('SELECT * FROM sales ORDER BY rowid DESC LIMIT ?', [max]);
  return rows.map(rowToSale);
});

// A report needs the sales inside its own date range, not the newest 500, so it
// asks for exactly that window. Timestamps are stored as ISO strings, which
// compare correctly as text.
ipcMain.handle('sales:between', (_event, from, to) => {
  const first = String(from || '');
  const last = String(to || '');
  if (!first || !last) throw new Error('Pick the dates for the report.');
  const rows = openDb().all('SELECT * FROM sales WHERE at >= ? AND at <= ? ORDER BY at ASC LIMIT 5000', [first, last]);
  return rows.map(rowToSale);
});

// Voiding a sale puts its items back on the shelf. The record stays in the books
// — a sale that never happened is still something the shop wants to see — so it
// is flagged rather than deleted, and it can only be voided once.
ipcMain.handle('sales:void', (_event, id) => {
  const conn = openDb();
  const key = String(id || '');
  const row = conn.get('SELECT * FROM sales WHERE id = ?', [key]);
  if (!row) throw new Error('That sale is no longer in the records.');
  if (row.voided) throw new Error('That sale has already been voided.');

  let items = [];
  try {
    items = JSON.parse(row.items);
  } catch (err) {
    items = [];
  }

  const now = new Date().toISOString();
  let returned = 0;
  let missing = 0;
  for (const line of Array.isArray(items) ? items : []) {
    const qty = Math.max(1, Math.round(asNumber(line && line.qty, 1)));
    const product = conn.get('SELECT id FROM products WHERE id = ?', [String((line && line.id) || '')]);
    // An item deleted since the sale has nowhere to go back to; it is counted so
    // the shopkeeper is told, rather than stock quietly going missing.
    if (!product) {
      missing += 1;
      continue;
    }
    conn.run('UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ?', [qty, now, product.id]);
    returned += qty;
  }

  conn.run('UPDATE sales SET voided = 1 WHERE id = ?', [key]);
  return { id: key, returned, missing };
});

// ---------------------------------------------------------------------------
// Frozen sales (hold and recall)
// ---------------------------------------------------------------------------
ipcMain.handle('holds:list', () => {
  const rows = openDb().all('SELECT * FROM holds ORDER BY rowid DESC');
  return rows.map(rowToHold);
});

// Park the current cart. The stock is untouched until the sale is finished.
ipcMain.handle('holds:create', (_event, payload) => {
  const conn = openDb();
  const list = Array.isArray(payload && payload.items) ? payload.items : [];
  if (!list.length) throw new Error('There are no items to freeze.');

  const lines = [];
  for (const item of list) {
    const name = String((item && item.name) || '').trim();
    if (!name) continue;
    lines.push({
      id: String(item.id || ''),
      name,
      price: Math.max(0, asNumber(item.price)),
      qty: Math.max(1, Math.round(asNumber(item.qty, 1))),
      image: item.image ? String(item.image) : null,
    });
  }
  if (!lines.length) throw new Error('There are no items to freeze.');

  const hold = {
    id: uid(),
    at: new Date().toISOString(),
    label: String(payload && payload.label ? payload.label : '').trim().slice(0, 60),
    items: lines,
    total: Math.round(lines.reduce((sum, line) => sum + line.price * line.qty, 0) * 100) / 100,
    count: lines.reduce((sum, line) => sum + line.qty, 0),
  };
  conn.run('INSERT INTO holds (id, at, label, items, total, count) VALUES (?,?,?,?,?,?)', [
    hold.id,
    hold.at,
    hold.label,
    JSON.stringify(hold.items),
    hold.total,
    hold.count,
  ]);
  return hold;
});

// Bring a frozen sale back into the cart and clear the hold in one step.
ipcMain.handle('holds:take', (_event, id) => {
  const conn = openDb();
  const hold = rowToHold(conn.get('SELECT * FROM holds WHERE id = ?', [String(id || '')]));
  if (!hold) throw new Error('That frozen sale is no longer here.');
  conn.run('DELETE FROM holds WHERE id = ?', [hold.id]);
  return hold;
});

ipcMain.handle('holds:delete', (_event, id) => {
  const result = openDb().run('DELETE FROM holds WHERE id = ?', [String(id || '')]);
  return result.changes > 0;
});

// ---------------------------------------------------------------------------
// Settings IPC
// ---------------------------------------------------------------------------
ipcMain.handle('settings:get', () => readSettings());

ipcMain.handle('settings:save', (_event, settings) => {
  openDb();
  if (settings && typeof settings.storeName === 'string' && settings.storeName.trim()) {
    putSetting('storeName', settings.storeName.trim().slice(0, 80));
  }
  if (settings && settings.lowStock != null) {
    putSetting('lowStock', String(Math.max(0, Math.round(asNumber(settings.lowStock, 5)))));
  }
  return readSettings();
});

// ---------------------------------------------------------------------------
// Backup: a dated snapshot of the whole database, kept in a Backups folder
// beside it. VACUUM INTO writes a consistent copy even while the app is being
// used, and it never touches the live file.
// ---------------------------------------------------------------------------
function backupDir() {
  const dir = path.join(app.getPath('userData'), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function backupNames() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const dir = backupDir();
  let n = 0;
  const suffix = () => (n ? ` (${n})` : '');
  let db = path.join(dir, `sari-pos-backup ${stamp}${suffix()}.db`);
  let zip = path.join(dir, `sari-pictures ${stamp}${suffix()}.zip`);
  while (fs.existsSync(db) || fs.existsSync(zip)) {
    n += 1;
    db = path.join(dir, `sari-pos-backup ${stamp}${suffix()}.db`);
    zip = path.join(dir, `sari-pictures ${stamp}${suffix()}.zip`);
  }
  return { db, zip };
}

// Only the pictures an item actually points at. The folder also holds
// leftovers from old searches, and those are not worth backing up.
function linkedPictures() {
  const rows = openDb().all("SELECT image FROM products WHERE image IS NOT NULL AND image <> ''");
  const seen = new Set();
  const entries = [];
  let missing = 0;
  for (const row of rows) {
    const name = String(row.image || '');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const full = safePicturePath(name); // basename only, and inside the folder
    if (full) entries.push({ full, name: path.basename(full) });
    else missing += 1;
  }
  return { entries, missing };
}

function zipPictures(entries, target) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const entry of entries) zip.addFile(entry.full, entry.name);
    zip.end();
    const out = fs.createWriteStream(target);
    out.on('error', reject);
    zip.outputStream.on('error', reject);
    out.on('close', resolve);
    zip.outputStream.pipe(out);
  });
}

ipcMain.handle('db:backup', async () => {
  const names = backupNames();
  openDb().run('VACUUM INTO ?', [names.db]);
  const size = fs.statSync(names.db).size;
  if (!size) throw new Error('The backup file came out empty.');

  const { entries, missing } = linkedPictures();
  let picturesZip = null;
  let picturesSize = 0;
  if (entries.length) {
    await zipPictures(entries, names.zip);
    picturesZip = names.zip;
    picturesSize = fs.statSync(names.zip).size;
  }

  return {
    file: names.db,
    size,
    pictures: entries.length,
    missing,
    picturesZip,
    picturesSize,
    at: new Date().toISOString(),
  };
});

// Only ever opens the Backups folder — the renderer cannot ask for any path.
ipcMain.handle('db:openFolder', () => shell.openPath(backupDir()));

// ---------------------------------------------------------------------------
// Restore: put a backup back. The live database is swapped for the chosen file
// and the pictures zip is unpacked over the pictures folder. Whatever is on the
// computer is copied into the Backups folder first, so a wrong file can be put
// back exactly as it was.
// ---------------------------------------------------------------------------
function backupStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// Opened on its own, without becoming the live database, so a file that is not
// this app's can be refused before anything is touched.
function readBackupSummary(file) {
  let probe = null;
  try {
    probe = new Database(file);
    const tables = new Set(
      probe.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => String(row.name))
    );
    if (!tables.has('products') || !tables.has('sales')) throw new Error('not a POS database');
    const products = probe.get('SELECT COUNT(*) AS n FROM products');
    const sales = probe.get('SELECT COUNT(*) AS n FROM sales');
    return {
      products: Number((products && products.n) || 0),
      sales: Number((sales && sales.n) || 0),
    };
  } finally {
    if (probe) {
      try {
        probe.close();
      } catch (err) {
        /* nothing left to close */
      }
    }
  }
}

// Unpack a pictures backup into the pictures folder. Every name is reduced to
// its base name and checked against the picture types, so a zip cannot write a
// script outside the folder it belongs in.
function extractPictures(zipFile, target) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipFile, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err) {
        reject(new Error('the pictures backup could not be opened'));
        return;
      }
      let saved = 0;
      let skipped = 0;
      zip.on('error', reject);
      zip.on('entry', (entry) => {
        const entryName = String(entry.fileName || '');
        const name = path.basename(entryName);
        const isPicture = Object.values(IMAGE_TYPES).includes(path.extname(name).toLowerCase());
        if (!name || name.startsWith('.') || /\/$/.test(entryName) || !isPicture) {
          skipped += 1;
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (openErr, stream) => {
          if (openErr) {
            skipped += 1;
            zip.readEntry();
            return;
          }
          const out = fs.createWriteStream(path.join(target, name));
          out.on('close', () => {
            saved += 1;
            zip.readEntry();
          });
          out.on('error', () => {
            skipped += 1;
            zip.readEntry();
          });
          stream.pipe(out);
        });
      });
      zip.on('end', () => resolve({ saved, skipped }));
      zip.readEntry();
    });
  });
}

ipcMain.handle('db:restore', async () => {
  const picked = await dialog.showOpenDialog(win, {
    title: 'Choose the backup to restore',
    buttonLabel: 'Restore this backup',
    defaultPath: backupDir(),
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Backups', extensions: ['db', 'zip'] },
      { name: 'Database backup', extensions: ['db'] },
      { name: 'Pictures backup', extensions: ['zip'] },
    ],
  });
  if (picked.canceled || !picked.filePaths.length) return { canceled: true };

  const chosen = picked.filePaths;
  const dbPath = chosen.find((file) => path.extname(file).toLowerCase() !== '.zip') || '';
  const zips = chosen.filter((file) => path.extname(file).toLowerCase() === '.zip');
  if (!dbPath) {
    throw new Error('Choose the database file (.db) from the backup, as well as the pictures.');
  }

  let summary;
  try {
    summary = readBackupSummary(dbPath);
  } catch (err) {
    throw new Error('That file is not a Sari-Sari POS backup. Choose the .db file the backup made.');
  }

  const target = dbFile();
  const safety = path.join(backupDir(), `before-restore ${backupStamp()}.db`);
  const hadData = fs.existsSync(target) && fs.statSync(target).size > 0;
  if (hadData) fs.copyFileSync(target, safety);

  try {
    closeDb();
    // A journal left behind by the old file must never be applied to the new one.
    for (const suffix of ['-wal', '-shm', '-journal']) {
      if (fs.existsSync(target + suffix)) fs.unlinkSync(target + suffix);
    }
    fs.copyFileSync(dbPath, target);
    openDb(); // reopens the restored file, and upgrades an older backup's schema
  } catch (err) {
    if (hadData) {
      try {
        fs.copyFileSync(safety, target);
      } catch (copyErr) {
        /* keep the original error */
      }
    }
    closeDb();
    try {
      openDb();
    } catch (openErr) {
      /* the app reports the real problem when it next reads */
    }
    throw new Error('The backup could not be put in place. Your data was left as it was.');
  }

  let pictures = null;
  if (zips.length) {
    const dir = pictureDir();
    let saved = 0;
    let skipped = 0;
    for (const zipFile of zips) {
      const got = await extractPictures(zipFile, dir);
      saved += got.saved;
      skipped += got.skipped;
    }
    pictures = { saved, skipped };
  }

  return {
    file: dbPath,
    products: summary.products,
    sales: summary.sales,
    pictures,
    safety: hadData ? safety : null,
    at: new Date().toISOString(),
  };
});

// ---------------------------------------------------------------------------
// Pictures IPC
// ---------------------------------------------------------------------------
// Money for change: the float the shop sets aside each morning so it can break
// a big bill. It is kept per day rather than as one running figure, so a new
// day starts back at zero without anyone having to clear it.
// ---------------------------------------------------------------------------
function dayKey(date) {
  const d = date instanceof Date ? date : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function cleanDay(value) {
  const day = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : dayKey(new Date());
}

function readChangeFund(day) {
  const row = openDb().get('SELECT amount FROM change_fund WHERE day = ?', [cleanDay(day)]);
  return row ? Math.max(0, asNumber(row.amount)) : 0;
}

ipcMain.handle('fund:get', (_event, day) => readChangeFund(day));

ipcMain.handle('fund:set', (_event, payload) => {
  const day = cleanDay(payload && payload.day);
  // A float is cash in the drawer: never negative, never a fraction of a cent.
  const amount = Math.max(0, Math.round(asNumber(payload && payload.amount) * 100) / 100);
  const stamp = new Date().toISOString();
  const conn = openDb();
  const updated = conn.run('UPDATE change_fund SET amount = ?, updated_at = ? WHERE day = ?', [
    amount,
    stamp,
    day,
  ]);
  if (!updated.changes) {
    conn.run('INSERT INTO change_fund (day, amount, updated_at) VALUES (?,?,?)', [day, amount, stamp]);
  }
  return { day, amount };
});

ipcMain.handle('fund:between', (_event, from, to) =>
  openDb().all('SELECT day, amount FROM change_fund WHERE day BETWEEN ? AND ? ORDER BY day', [
    cleanDay(from),
    cleanDay(to),
  ])
);

// ---------------------------------------------------------------------------
// Reports: the page itself is built in the renderer, and turned into a PDF here,
// so the shop gets a real file to save, print or send without a print dialog.
ipcMain.handle('reports:pdf', async (_event, payload) => {
  const html = String((payload && payload.html) || '');
  if (!html.trim()) throw new Error('Open a report before saving it.');

  const suggested =
    String((payload && payload.name) || 'sari-sari-report')
      .replace(/[^A-Za-z0-9 ()-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'sari-sari-report';

  const chosen = await dialog.showSaveDialog(win, {
    title: 'Save the report as a PDF',
    defaultPath: path.join(app.getPath('documents'), `${suggested}.pdf`),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (chosen.canceled || !chosen.filePath) return { canceled: true };
  const target = /\.pdf$/i.test(chosen.filePath) ? chosen.filePath : `${chosen.filePath}.pdf`;

  // The report is rendered in its own hidden window: printing the live window
  // would capture the whole till instead of the sheet of paper.
  const temp = path.join(app.getPath('temp'), `sari-report-${Date.now()}.html`);
  fs.writeFileSync(temp, html, 'utf8');
  const sheet = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await sheet.loadFile(temp);
    const pdf = await sheet.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
    });
    fs.writeFileSync(target, pdf);
  } finally {
    if (!sheet.isDestroyed()) sheet.destroy();
    try {
      fs.unlinkSync(temp);
    } catch (err) {
      /* a leftover temp file is harmless */
    }
  }
  return { file: target, size: fs.statSync(target).size };
});

ipcMain.handle('images:choose', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose a picture for this product',
    properties: ['openFile'],
    filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const file = result.filePaths[0];
  const buf = fs.readFileSync(file);
  return storePicture(buf, path.extname(file).replace('.', 'image/'));
});

ipcMain.handle('images:download', async (_event, rawInput) => {
  const urls = (Array.isArray(rawInput) ? rawInput : [rawInput])
    .map((u) => String(u || '').trim())
    .filter(Boolean)
    .slice(0, 4);
  if (!urls.length) throw new Error('Paste a picture link first.');

  const reasons = [];
  for (const raw of urls) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch (err) {
      reasons.push('that is not a valid link');
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reasons.push('only http and https links are allowed');
      continue;
    }

    // One retry: a dropped connection or a 5xx answer is often gone on the
    // second try, and giving up here is what left products without a picture.
    let lastReason = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const got = await fetchPictureCandidate(parsed.href);
      if (got.file) return got.file;
      lastReason = got.reason;
      if (got.status >= 400 && got.status < 500) break; // a 4xx will not change
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    if (lastReason && !reasons.includes(lastReason)) reasons.push(lastReason);
  }

  const detail = reasons.slice(0, 2).join('; ') || 'unknown reason';
  throw new Error(`the picture could not be downloaded (${detail})`);
});

ipcMain.handle('images:search', async (_event, query) => {
  const q = String(query || '').trim();
  if (!q) throw new Error('Type what you are looking for.');

  // Real product names (with brand and size) often find nothing, so fall back
  // to the first two words before giving up.
  const words = q.split(/\s+/);
  const candidates = words.length > 2 ? [q, words.slice(0, 2).join(' ')] : [q];
  const problems = [];

  for (const candidate of candidates) {
    const settled = await Promise.allSettled([
      searchWikimedia(candidate),
      searchOpenverse(candidate),
    ]);
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled' && outcome.value.length) return outcome.value;
      if (outcome.status === 'fulfilled') {
        problems.push('no pictures found');
      } else {
        const err = outcome.reason;
        const detail =
          String((err && err.message) || err) + (err && err.cause ? ': ' + (err.cause.message || err.cause) : '');
        console.error('[picture-search]', detail);
        problems.push(detail);
      }
    }
  }

  if (problems.length && problems.every((p) => p === 'no pictures found')) {
    throw new Error(`No pictures found for “${q}”. Try fewer words, or paste a picture link.`);
  }
  throw new Error('No pictures could be loaded (' + problems.join('; ') + '). You can paste a picture link instead.');
});
