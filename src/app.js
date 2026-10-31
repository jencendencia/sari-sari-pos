/* Sari-Sari POS — renderer logic.
   One screen per job, big numbers, everything reversible until payment. */

// Atkinson Hyperlegible is designed for low vision, so it is worth having —
// but never at the cost of a slow start. Load it after the app is running;
// offline, the system fallback in styles.css simply takes over.
const typeface = document.createElement('link');
typeface.rel = 'stylesheet';
typeface.href =
  'https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&display=swap';
document.head.appendChild(typeface);

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const esc = (value) =>
  String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));

const peso = (n) =>
  '₱' +
  Number(n || 0).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const state = {
  products: [],
  sales: [],
  cart: [],
  holds: [],
  settings: { storeName: 'My Sari-Sari Store', lowStock: 5 },
  screen: 'sell',
  cash: '',
  editingId: null,
  editingImage: null,
};

/* ------------------------------------------------------------------ sound */
let audioCtx = null;
function beep(kind) {
  if (localStorage.getItem('pos-muted') === '1') return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = kind === 'ok' ? 920 : kind === 'done' ? 660 : 220;
    const t = audioCtx.currentTime;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.16, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.22);
  } catch (err) {
    /* sound is a bonus, never a blocker */
  }
}

function flash(good) {
  const el = document.createElement('div');
  el.className = 'scrim-flash' + (good ? '' : ' bad');
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 400);
}

/* ------------------------------------------------------------------- toast */
let toastTimer = null;

function toast(message, options = {}) {
  const box = $('#toast');
  clearTimeout(toastTimer);
  box.classList.toggle('is-error', !!options.error);
  box.innerHTML = `<span>${esc(message)}</span>`;
  if (options.action) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = options.action;
    btn.addEventListener('click', () => {
      box.hidden = true;
      if (options.onAction) options.onAction();
    });
    box.appendChild(btn);
  }
  box.hidden = false;
  toastTimer = setTimeout(() => {
    box.hidden = true;
  }, options.duration || 5000);
}

/* ------------------------------------------------------------------ confirm */
let confirmResolve = null;

function confirmBox(title, text, yesLabel) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    $('#confirmTitle').textContent = title;
    $('#confirmText').textContent = text;
    $('#confirmYes').textContent = yesLabel || 'Yes';
    openModal('modal-confirm');
  });
}

function settleConfirm(value) {
  $('#modal-confirm').hidden = true;
  if (confirmResolve) {
    const done = confirmResolve;
    confirmResolve = null;
    done(value);
  }
}

/* ------------------------------------------------------------------- modals */
function openModal(id) {
  document.getElementById(id).hidden = false;
}

function closeModal(id) {
  document.getElementById(id).hidden = true;
}

$$('[data-close]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const backdrop = btn.closest('.modal-backdrop');
    if (backdrop) backdrop.hidden = true;
    focusScanner();
  });
});

// Clicking the dark backdrop closes non-destructive dialogs.
$$('.modal-backdrop').forEach((backdrop) => {
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target !== backdrop) return;
    if (backdrop.id === 'modal-confirm') return;
    backdrop.hidden = true;
    focusScanner();
  });
});

function focusScanner() {
  if (state.screen !== 'sell') return;
  if ($$('.modal-backdrop:not([hidden])').length) return;
  $('#scanInput').focus();
}

/* -------------------------------------------------------------------- cart */
function cartTotal() {
  return state.cart.reduce((sum, line) => sum + line.price * line.qty, 0);
}

function cartCount() {
  return state.cart.reduce((sum, line) => sum + line.qty, 0);
}

function renderCart() {
  const list = $('#cartList');
  const count = cartCount();
  $('#cartCount').textContent = count === 1 ? '1 item' : `${count} items`;
  $('#totalAmount').textContent = peso(cartTotal());
  $('#payBtn').disabled = count === 0;
  $('#freezeBtn').disabled = count === 0;
  $('#clearCartBtn').disabled = count === 0;
  $('#cartEmpty').hidden = count > 0;

  list.innerHTML = state.cart
    .map((line, index) => {
      const pic = line.image
        ? `<img class="thumb" src="${esc(window.api.pictureUrl(line.image))}" alt="" />`
        : `<div class="thumb thumb-empty">🛒</div>`;
      return `
      <div class="cart-row" data-index="${index}">
        ${pic}
        <div>
          <div class="cart-name">${esc(line.name)}</div>
          <div class="cart-unit">${peso(line.price)} each</div>
        </div>
        <div class="qty">
          <button type="button" data-act="minus" aria-label="One less">−</button>
          <span class="qty-value">${line.qty}</span>
          <button type="button" data-act="plus" aria-label="One more">+</button>
        </div>
        <div class="cart-end">
          <div class="cart-line-total">${peso(line.price * line.qty)}</div>
          <button type="button" class="row-remove" data-act="remove" aria-label="Remove ${esc(line.name)} from this sale">✕ Remove</button>
        </div>
      </div>`;
    })
    .join('');
}

function addToCart(product, quiet) {
  const existing = state.cart.find((line) => line.id === product.id);
  if (existing) existing.qty += 1;
  else
    state.cart.push({
      id: product.id,
      name: product.name,
      price: Number(product.price) || 0,
      image: product.image || null,
      qty: 1,
    });
  renderCart();
  if (!quiet) {
    beep('ok');
    flash(true);
    toast(`Added: ${product.name}`);
  }
  focusScanner();
}

$('#cartList').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-act]');
  if (!button) return;
  const row = button.closest('.cart-row');
  const index = Number(row.dataset.index);
  const line = state.cart[index];
  if (!line) return;

  const act = button.dataset.act;
  if (act === 'plus') {
    line.qty += 1;
  } else if (act === 'minus') {
    if (line.qty > 1) line.qty -= 1;
    else return removeCartLine(index);
  } else if (act === 'remove') {
    return removeCartLine(index);
  }
  renderCart();
  focusScanner();
});

function removeCartLine(index) {
  const [removed] = state.cart.splice(index, 1);
  renderCart();
  focusScanner();
  beep('bad');
  toast(`Removed: ${removed.name}`, {
    action: 'Undo',
    onAction: () => {
      state.cart.splice(index, 0, removed);
      renderCart();
      focusScanner();
    },
  });
}

$('#clearCartBtn').addEventListener('click', async () => {
  if (!state.cart.length) return;
  const ok = await confirmBox(
    'Cancel this sale?',
    `You are about to throw away ${cartCount()} item(s) and a total of ${peso(cartTotal())}.`,
    'Yes, cancel it'
  );
  if (!ok) return;
  state.cart = [];
  renderCart();
  focusScanner();
  toast('The sale was cancelled.');
});

/* ------------------------------------------------------------ price check */
function openPriceCheck() {
  $('#priceCode').value = '';
  priceSelectedId = null;
  $('#priceCard').hidden = true;
  $('#priceStatus').hidden = true;
  $('#priceResults').hidden = true;
  $('#priceResults').innerHTML = '';
  openModal('modal-price');
  setTimeout(() => $('#priceCode').focus(), 30);
}

// A price check accepts either a barcode or part of a name, so the shopkeeper
// can answer "how much is the coke?" without knowing the code.
function priceMatches(raw) {
  const query = String(raw || '').trim();
  if (!query) return [];
  const code = query.replace(/[\s-]/g, '');
  const needle = query.toLowerCase();

  const byCode = findLocalProduct(code);
  if (byCode) return [byCode];

  // A barcode half-typed by hand: let a few digits narrow it down.
  if (/^\d{3,}$/.test(code)) {
    const partial = state.products.filter((p) => String(p.barcode || '').trim().startsWith(code));
    if (partial.length) return partial;
  }

  return state.products.filter(
    (p) =>
      p.name.toLowerCase().includes(needle) || String(p.barcode || '').trim() === code
  );
}

let priceSelectedId = null;

function showPrice(product) {
  priceSelectedId = product.id;
  const stock = Number(product.stock) || 0;
  const low = product.lowStock != null ? product.lowStock : state.settings.lowStock;
  $('#priceName').textContent = product.name;
  $('#priceAmount').textContent = peso(product.price);
  $('#priceMeta').textContent =
    stock === 0
      ? 'Out of stock'
      : stock <= low
        ? `Only ${stock} left`
        : `${stock} in stock`;
  $('#priceMeta').className = 'price-meta ' + (stock === 0 ? 'stock-out' : stock <= low ? 'stock-low' : 'stock-ok');

  const pic = $('#pricePic');
  const wrap = $('#pricePicWrap');
  if (product.image) {
    pic.src = window.api.pictureUrl(product.image);
    wrap.hidden = false;
  } else {
    wrap.hidden = true;
    pic.removeAttribute('src');
  }
  $('#priceCard').hidden = false;
}

function renderPriceResults(matches) {
  const list = $('#priceResults');
  if (matches.length < 2) {
    list.hidden = true;
    list.innerHTML = '';
    return;
  }
  list.innerHTML = matches
    .map(
      (p) => `
      <button type="button" class="picker-item price-hit${p.id === priceSelectedId ? ' is-on' : ''}" data-id="${esc(p.id)}" aria-pressed="${p.id === priceSelectedId}">
        <div class="thumb thumb-empty">🏷️</div>
        <div>
          <div class="picker-name">${esc(p.name)}</div>
          <div class="inv-meta">${esc(String(p.barcode || '').trim() || 'No barcode')}</div>
        </div>
        <div class="picker-price">${peso(p.price)}</div>
      </button>`
    )
    .join('');
  list.hidden = false;
}

function runPriceCheck(raw) {
  const query = String(raw || '').trim();
  if (!query) return;
  const status = $('#priceStatus');
  const matches = priceMatches(query);

  if (!matches.length) {
    $('#priceCard').hidden = true;
    $('#priceResults').hidden = true;
    $('#priceResults').innerHTML = '';
    status.hidden = false;
    status.className = 'pic-status is-error';
    status.textContent = `Nothing matches “${query}”. Check the spelling, or add it in Inventory first.`;
    beep('bad');
    return;
  }

  status.hidden = true;
  showPrice(matches[0]);
  renderPriceResults(matches);
  beep('ok');
}

$('#priceCheckBtn').addEventListener('click', openPriceCheck);
$('#priceGoBtn').addEventListener('click', () => runPriceCheck($('#priceCode').value));
$('#priceCode').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    runPriceCheck(event.target.value);
  }
});

// Several items matched: tap one to see its price.
$('#priceResults').addEventListener('click', (event) => {
  const hit = event.target.closest('.price-hit');
  if (!hit) return;
  const product = state.products.find((p) => p.id === hit.dataset.id);
  if (!product) return;
  showPrice(product);
  renderPriceResults(priceMatches($('#priceCode').value));
  $('#priceStatus').hidden = true;
  beep('ok');
});

/* --------------------------------------------------- frozen sales (freeze) */
async function refreshHolds() {
  state.holds = (await window.api.listHolds()) || [];
  const badge = $('#holdsCount');
  badge.textContent = String(state.holds.length);
  badge.hidden = state.holds.length === 0;
}

async function freezeCurrentSale() {
  if (!state.cart.length) return;
  const count = cartCount();
  const total = cartTotal();
  const ok = await confirmBox(
    'Freeze this sale?',
    `These ${count} item(s) and a total of ${peso(total)} will be kept here. Nothing is sold yet, and you can bring it back any time.`,
    'Yes, freeze it'
  );
  if (!ok) return;

  try {
    await window.api.freezeSale({
      label: `${count} item(s) · ${peso(total)}`,
      items: state.cart,
    });
  } catch (err) {
    beep('bad');
    flash(false);
    toast(String((err && err.message) || err), { error: true });
    return;
  }

  state.cart = [];
  renderCart();
  await refreshHolds();
  beep('done');
  flash(true);
  focusScanner();
  toast('Sale frozen. Bring it back from Frozen sales.', { duration: 6000 });
}

async function renderHolds() {
  const list = $('#holdsList');
  if (!state.holds.length) {
    list.innerHTML = `<div class="empty-state"><span class="big">🧊</span>No frozen sales.<br />Press <b>Freeze this sale</b> to park one.</div>`;
    return;
  }
  list.innerHTML = state.holds
    .map(
      (hold) => `
      <div class="picker-item hold-item" data-id="${esc(hold.id)}">
        <div class="hold-mark">🧊</div>
        <div>
          <div class="picker-name">${esc(hold.label || `${hold.count} item(s)`)}</div>
          <div class="inv-meta">Frozen ${esc(holdAt(hold.at))}</div>
        </div>
        <div class="hold-actions">
          <div class="picker-price">${peso(hold.total)}</div>
          <button type="button" class="btn btn-green btn-sm" data-act="take">Bring back</button>
          <button type="button" class="btn btn-danger btn-sm" data-act="drop">Delete</button>
        </div>
      </div>`
    )
    .join('');
}

function holdAt(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
        ' ' +
        d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

async function openHolds() {
  await refreshHolds();
  await renderHolds();
  openModal('modal-holds');
}

async function takeHold(id) {
  if (state.cart.length) {
    const ok = await confirmBox(
      'Replace the cart?',
      `You have ${cartCount()} item(s) in this sale. Bringing back the frozen sale will replace them.`,
      'Yes, replace it'
    );
    if (!ok) return;
  }

  let hold;
  try {
    hold = await window.api.takeHold(id);
  } catch (err) {
    beep('bad');
    flash(false);
    toast(String((err && err.message) || err), { error: true });
    return;
  }

  state.cart = hold.items.map((line) => ({
    id: line.id,
    name: line.name,
    price: Number(line.price) || 0,
    image: line.image || null,
    qty: Math.max(1, Number(line.qty) || 1),
  }));
  closeModal('modal-holds');
  showScreen('sell');
  renderCart();
  await refreshHolds();
  beep('done');
  flash(true);
  toast(`Brought back ${cartCount()} item(s).`);
}

async function dropHold(id) {
  const ok = await confirmBox('Delete this frozen sale?', 'It will be gone for good.', 'Yes, delete it');
  if (!ok) return;
  try {
    await window.api.deleteHold(id);
  } catch (err) {
    beep('bad');
    toast(String((err && err.message) || err), { error: true });
    return;
  }
  await refreshHolds();
  await renderHolds();
  toast('Frozen sale deleted.');
}

$('#freezeBtn').addEventListener('click', freezeCurrentSale);
$('#holdsBtn').addEventListener('click', openHolds);

$('#holdsList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-act]');
  const row = event.target.closest('.hold-item');
  if (!button || !row) return;
  if (button.dataset.act === 'take') takeHold(row.dataset.id);
  if (button.dataset.act === 'drop') dropHold(row.dataset.id);
});

/* ------------------------------------------------------------------ scan */
function findLocalProduct(code) {
  const needle = String(code || '').trim();
  if (!needle) return null;
  return state.products.find((p) => String(p.barcode || '').trim() === needle) || null;
}

async function submitScan(raw) {
  const code = String(raw || '').trim();
  if (!code) return;
  $('#scanInput').value = '';
  const product = findLocalProduct(code);
  if (product) return addToCart(product);

  beep('bad');
  flash(false);
  const ok = await confirmBox(
    'Unknown barcode',
    `Barcode ${code} is not in your inventory yet. Add it as a new product now?`,
    'Yes, add it'
  );
  if (ok) openProductForm(null, code);
  else focusScanner();
}

$('#scanInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    submitScan(event.target.value);
  }
});

// Barcode scanners behave like a very fast keyboard: when nothing is being
// typed into a field, collect the burst of keystrokes and treat Enter as a scan.
let scanBuffer = '';
let lastKeyTime = 0;

document.addEventListener('keydown', (event) => {
  const active = document.activeElement;
  const typing =
    active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
  if (typing) return;

  if (event.key === 'Enter') {
    if (scanBuffer.length >= 3) {
      const code = scanBuffer;
      scanBuffer = '';
      event.preventDefault();
      submitScan(code);
      return;
    }
    scanBuffer = '';
    return;
  }

  if (event.key.length === 1) {
    const now = Date.now();
    if (now - lastKeyTime > 150) scanBuffer = '';
    lastKeyTime = now;
    scanBuffer += event.key;
  } else {
    scanBuffer = '';
  }
});

/* ------------------------------------------------------------------ screens */
function showScreen(name) {
  state.screen = name;
  $$('.screen').forEach((screen) => screen.classList.toggle('active', screen.id === `screen-${name}`));
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.screen === name));
  if (name === 'inventory') renderInventory();
  if (name === 'history') renderHistory();
  focusScanner();
}

$$('.tab').forEach((tab) => tab.addEventListener('click', () => showScreen(tab.dataset.screen)));

/* --------------------------------------------------------- item picker */
function openPicker() {
  $('#pickerSearch').value = '';
  renderPicker('');
  openModal('modal-picker');
  setTimeout(() => $('#pickerSearch').focus(), 30);
}

function renderPicker(query) {
  const q = String(query || '').trim().toLowerCase();
  const matches = state.products.filter(
    (p) => !q || p.name.toLowerCase().includes(q) || String(p.barcode || '').includes(q)
  );
  const list = $('#pickerList');
  if (!matches.length) {
    list.innerHTML = `<div class="empty-state">No product matches “${esc(query)}”.<br />Add it in <b>Inventory</b> first.</div>`;
    return;
  }
  list.innerHTML = matches
    .slice(0, 60)
    .map((p) => {
      const pic = p.image
        ? `<img class="thumb" src="${esc(window.api.pictureUrl(p.image))}" alt="" />`
        : `<div class="thumb thumb-empty">🛒</div>`;
      return `
      <button type="button" class="picker-item" data-id="${esc(p.id)}">
        ${pic}
        <span class="picker-name">${esc(p.name)}<br /><span class="inv-meta">Stock: ${p.stock}</span></span>
        <span class="picker-price">${peso(p.price)}</span>
      </button>`;
    })
    .join('');
}

$('#findItemBtn').addEventListener('click', openPicker);
$('#pickerSearch').addEventListener('input', (event) => renderPicker(event.target.value));
$('#pickerList').addEventListener('click', (event) => {
  const button = event.target.closest('.picker-item');
  if (!button) return;
  const product = state.products.find((p) => p.id === button.dataset.id);
  if (!product) return;
  closeModal('modal-picker');
  addToCart(product);
});

/* -------------------------------------------------------------- inventory */
function stockFlagClass(product) {
  const low = product.lowStock != null ? product.lowStock : state.settings.lowStock;
  if (product.stock <= 0) return 'stock-out';
  if (product.stock <= low) return 'stock-low';
  return 'stock-ok';
}

function stockFlagText(product) {
  const cls = stockFlagClass(product);
  if (cls === 'stock-out') return 'Out of stock';
  if (cls === 'stock-low') return 'Running low';
  return 'In stock';
}

function renderInventory() {
  const q = $('#invSearch').value.trim().toLowerCase();
  const items = state.products
    .filter((p) => !q || p.name.toLowerCase().includes(q) || String(p.barcode || '').toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));

  const list = $('#invList');
  if (!items.length) {
    list.innerHTML = `<div class="empty-state"><span class="big">📦</span>${
      q ? `No product matches “${esc(q)}”.` : 'Your inventory is empty.'
    }<br />Press <b>Add product</b> to put the first item in.</div>`;
    return;
  }

  list.innerHTML = items
    .map((p) => {
      const pic = p.image
        ? `<img class="thumb" src="${esc(window.api.pictureUrl(p.image))}" alt="" />`
        : `<div class="thumb thumb-empty">🛒</div>`;
      const flag = stockFlagClass(p);
      return `
      <div class="inv-row" data-id="${esc(p.id)}">
        ${pic}
        <div>
          <div class="inv-name">${esc(p.name)}</div>
          <div class="inv-meta">${p.barcode ? 'Barcode: ' + esc(p.barcode) : 'No barcode'}</div>
        </div>
        <div class="inv-price">
          ${peso(p.price)}
          ${
            Number(p.originalPrice) > 0
              ? `<div class="inv-orig">Original ${peso(p.originalPrice)}</div>`
              : ''
          }
        </div>
        <div class="stock-box">
          <button type="button" data-act="minus" aria-label="Less stock">−</button>
          <div>
            <span class="stock-num">${p.stock}</span>
            <span class="stock-flag ${flag}">${stockFlagText(p)}</span>
          </div>
          <button type="button" data-act="plus" aria-label="More stock">+</button>
        </div>
        <button type="button" class="btn btn-ghost" data-act="edit">✏️ Edit</button>
      </div>`;
    })
    .join('');
}

$('#invSearch').addEventListener('input', renderInventory);
$('#addProductBtn').addEventListener('click', () => openProductForm());

$('#invList').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-act]');
  if (!button) return;
  const row = button.closest('.inv-row');
  const product = state.products.find((p) => p.id === row.dataset.id);
  if (!product) return;

  if (button.dataset.act === 'edit') return openProductForm(product);

  const delta = button.dataset.act === 'plus' ? 1 : -1;
  if (product.stock + delta < 0) return;
  product.stock += delta;
  await window.api.saveProduct(product);
  renderInventory();
  toast(`${product.name}: stock is now ${product.stock}`);
});

/* ----------------------------------------------------------- product form */
function setPreview(filename) {
  const img = $('#pPreview');
  const empty = $('#pPreviewEmpty');
  if (filename) {
    img.src = window.api.pictureUrl(filename);
    img.hidden = false;
    empty.hidden = true;
  } else {
    img.removeAttribute('src');
    img.hidden = true;
    empty.hidden = false;
  }
}

function openProductForm(product, scanBarcode) {
  state.editingId = product ? product.id : null;
  state.editingImage = product && product.image ? product.image : null;
  $('#productTitle').textContent = product ? `Edit: ${product.name}` : 'Add a product';
  $('#pName').value = product ? product.name : '';
  lastProductName = $('#pName').value;
  $('#pBarcode').value = product && product.barcode ? product.barcode : scanBarcode || '';
  lookupStatus('');
  $('#pPrice').value = product ? product.price : '';
  $('#pOriginal').value = product && product.originalPrice ? product.originalPrice : '';
  $('#pStock').value = product ? product.stock : '';
  $('#pLow').value = product && product.lowStock != null ? product.lowStock : state.settings.lowStock;
  $('#deleteProductBtn').hidden = !product;
  $('#picUrl').value = '';
  $('#picQuery').value = product && product.name ? product.name : $('#pName').value;
  $('#picResults').hidden = true;
  $('#picResults').innerHTML = '';
  $('#picStatus').hidden = true;
  setPreview(state.editingImage);
  openModal('modal-product');
  setTimeout(() => $('#pName').focus(), 30);

  // A barcode that was just scanned is looked up online straight away, so the
  // shopkeeper only has to check the price.
  if (!product && scanBarcode) setTimeout(() => lookupOnline(scanBarcode), 60);
}

$('#productForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = {
    id: state.editingId,
    name: $('#pName').value,
    barcode: $('#pBarcode').value,
    price: $('#pPrice').value,
    originalPrice: $('#pOriginal').value,
    stock: $('#pStock').value || 0,
    lowStock: $('#pLow').value,
    image: state.editingImage,
  };
  try {
    const saved = await window.api.saveProduct(payload);
    const index = state.products.findIndex((p) => p.id === saved.id);
    if (index >= 0) state.products[index] = saved;
    else state.products.push(saved);
    closeModal('modal-product');
    renderInventory();
    renderCart();
    toast(`Saved: ${saved.name}`, { action: 'Add one to the cart', onAction: () => addToCart(saved) });
    focusScanner();
  } catch (err) {
    toast(err.message || 'Could not save the product.', { error: true, duration: 7000 });
  }
});

$('#deleteProductBtn').addEventListener('click', async () => {
  const product = state.products.find((p) => p.id === state.editingId);
  if (!product) return;
  const ok = await confirmBox('Delete this product?', `${product.name} will be removed from your inventory.`, 'Yes, delete');
  if (!ok) return;
  await window.api.deleteProduct(product.id);
  state.products = state.products.filter((p) => p.id !== product.id);
  closeModal('modal-product');
  renderInventory();
  toast(`Deleted: ${product.name}`);
  focusScanner();
});

/* ------------------------------------------------------- product pictures */
// Typing the name fills the internet search box, unless the shopkeeper has
// already written their own search words.
let lastProductName = '';

function lookupStatus(message, kind) {
  const el = $('#lookupStatus');
  if (!message) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = message;
  el.classList.toggle('is-error', kind === 'error');
  el.classList.toggle('is-ok', kind === 'ok');
}

function composeName(found) {
  const name = found.name;
  const parts = [];
  if (found.brand && !name.toLowerCase().includes(found.brand.toLowerCase())) parts.push(found.brand);
  if (found.size) parts.push(found.size);
  return parts.length ? `${name} (${parts.join(' ')})` : name;
}

function errText(err) {
  const raw = String((err && err.message) || err || 'Something went wrong.');
  // Electron prefixes errors thrown by the main process with this boilerplate.
  const clean = raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '').trim();
  const text = clean || 'Something went wrong.';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

async function lookupOnline(rawCode) {
  const code = String(rawCode || '').replace(/[\s-]/g, '');
  if (!/^\d{6,14}$/.test(code)) {
    lookupStatus('A barcode is made of numbers — scan or type it first.', 'error');
    return false;
  }

  lookupStatus(`Looking up ${code} on the internet… this can take a moment.`);
  try {
    const found = await window.api.lookupBarcode(code);
    if (!found) {
      lookupStatus('That barcode is not online. Please type the product name yourself.', 'error');
      return false;
    }

    const name = composeName(found);
    const nameWasEmpty = !$('#pName').value.trim();
    if (nameWasEmpty) {
      $('#pName').value = name;
      $('#pName').dispatchEvent(new Event('input', { bubbles: true }));
    }
    const headline = nameWasEmpty ? `Found: ${name}` : `Online name: ${name} (yours was kept)`;
    lookupStatus(headline, 'ok');

    if (!state.editingImage && (found.image || (found.images && found.images.length))) {
      lookupStatus(`${headline} — downloading the picture…`, 'ok');
      try {
        const file = await window.api.downloadPicture(found.images && found.images.length ? found.images : [found.image]);
        state.editingImage = file;
        setPreview(file);
        lookupStatus(`${headline} — picture saved.`, 'ok');
        beep('ok');
      } catch (err) {
        // Direct download failed. Say why, then search the internet for a
        // picture instead so the shopkeeper only has to tap one.
        const reason = errText(err);
        lookupStatus(`${headline} — the picture could not be downloaded (${reason}).`, 'error');
        $('#picQuery').value = name;
        const foundAny = await runPictureSearch(name);
        if (foundAny) {
          lookupStatus(`${headline} — the picture could not be downloaded (${reason}). Tap one of the pictures below instead.`, 'error');
        }
      }
    }
    return true;
  } catch (err) {
    lookupStatus('Could not reach the internet. Type the product name yourself.', 'error');
    return false;
  }
}

$('#lookupBtn').addEventListener('click', () => lookupOnline($('#pBarcode').value));

$('#pName').addEventListener('input', () => {
  const box = $('#picQuery');
  const name = $('#pName').value;
  if (!box.value.trim() || box.value === lastProductName) box.value = name;
  lastProductName = name;
});

function picStatus(message, kind) {
  const el = $('#picStatus');
  if (!message) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = message;
  el.classList.toggle('is-error', kind === 'error');
  el.classList.toggle('is-ok', kind === 'ok');
}

async function runPictureSearch(rawQuery) {
  const query = String(rawQuery || '').trim();
  if (!query) {
    toast('Type a few words to search for.', { error: true });
    $('#picQuery').focus();
    return false;
  }
  picStatus('Searching the internet…');
  $('#picResults').hidden = true;
  try {
    const results = await window.api.searchPictures(query);
    const box = $('#picResults');
    box.innerHTML = results
      .map((r, i) =>
        r.thumbData
          ? `<button type="button" data-i="${i}" title="${esc(r.title)}"><img src="${r.thumbData}" alt="${esc(r.title)}" /></button>`
          : `<button type="button" data-i="${i}" title="${esc(r.title)}"><span class="no-thumb">🖼<br />${esc(r.title).slice(0, 40)}</span></button>`
      )
      .join('');
    box.hidden = false;
    box._results = results;
    picStatus(`Found ${results.length} pictures — tap the one you like.`, 'ok');
    return true;
  } catch (err) {
    picStatus(errText(err), 'error');
    return false;
  }
}

$('#picSearchBtn').addEventListener('click', () => {
  runPictureSearch($('#picQuery').value);
});

$('#picResults').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-i]');
  if (!button) return;
  const results = $('#picResults')._results || [];
  const chosen = results[Number(button.dataset.i)];
  if (!chosen) return;
  picStatus('Downloading that picture…');
  try {
    const filename = await window.api.downloadPicture(chosen.url);
    state.editingImage = filename;
    setPreview(filename);
    $('#picResults').hidden = true;
    picStatus('Picture saved.', 'ok');
    beep('ok');
  } catch (err) {
    picStatus(errText(err), 'error');
  }
});

$('#picUrlBtn').addEventListener('click', async () => {
  const url = $('#picUrl').value.trim();
  if (!url) {
    toast('Paste a picture link first.', { error: true });
    return;
  }
  picStatus('Downloading the picture…');
  try {
    const filename = await window.api.downloadPicture(url);
    state.editingImage = filename;
    setPreview(filename);
    picStatus('Picture saved.', 'ok');
    beep('ok');
  } catch (err) {
    picStatus(errText(err), 'error');
  }
});

$('#picFileBtn').addEventListener('click', async () => {
  try {
    const filename = await window.api.choosePicture();
    if (!filename) return;
    state.editingImage = filename;
    setPreview(filename);
    picStatus('Picture added.', 'ok');
    beep('ok');
  } catch (err) {
    picStatus(errText(err), 'error');
  }
});

$('#picClearBtn').addEventListener('click', () => {
  state.editingImage = null;
  setPreview(null);
  picStatus('Picture removed.', 'ok');
});

/* -------------------------------------------------------------- payment */
function cashValue() {
  return Number(state.cash || '0');
}

function renderPayment() {
  const total = cartTotal();
  const cash = cashValue();
  const change = cash - total;
  $('#cashDisplay').textContent = peso(cash);
  $('#changeAmount').textContent = change >= 0 ? peso(change) : '—';
  $('#changeNote').textContent =
    cash === 0
      ? 'Enter the cash received'
      : change < 0
        ? `Still short by ${peso(Math.abs(change))}`
        : 'Hand this back to the customer';
  $('#finishBtn').disabled = !(cash >= total && total > 0);
}

$('#payBtn').addEventListener('click', () => {
  if (!state.cart.length) return;
  state.cash = '';
  $('#payTotal').textContent = peso(cartTotal());
  renderPayment();
  openModal('modal-pay');
});

$('#quickRow').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-quick]');
  if (!button) return;
  state.cash = button.dataset.quick === 'exact' ? String(cartTotal()) : button.dataset.quick;
  renderPayment();
  beep('ok');
});

$('#keypad').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-key]');
  if (!button) return;
  const key = button.dataset.key;
  if (key === 'back') state.cash = state.cash.slice(0, -1);
  else if (state.cash.length < 9) state.cash = (state.cash + key).replace(/^0+(?=\d)/, '');
  renderPayment();
});

$('#finishBtn').addEventListener('click', async () => {
  try {
    const sale = await window.api.createSale({
      items: state.cart.map((line) => ({ id: line.id, qty: line.qty })),
      paid: cashValue(),
    });
    state.sales.unshift(sale);
    const byId = new Map(state.products.map((p) => [p.id, p]));
    sale.items.forEach((line) => {
      const product = byId.get(line.id);
      if (product) product.stock = Math.max(0, product.stock - line.qty);
    });
    state.cart = [];
    renderCart();
    closeModal('modal-pay');
    showReceipt(sale, true);
    updateToday();
    beep('done');
    flash(true);
  } catch (err) {
    toast(err.message || 'The sale could not be saved.', { error: true, duration: 7000 });
  }
});

/* -------------------------------------------------------------- receipts */
function receiptHtml(sale) {
  const when = new Date(sale.at);
  const lines = sale.items
    .map(
      (line) => `
      <div class="receipt-line"><span>${esc(line.name)}</span><span>${peso(line.price * line.qty)}</span></div>
      <div class="receipt-line qty"><span>&nbsp;&nbsp;${line.qty} × ${peso(line.price)}</span><span></span></div>`
    )
    .join('');

  return `
    <div class="receipt-store">${esc(state.settings.storeName)}</div>
    <div class="receipt-when">${when.toLocaleString('en-PH', {
      dateStyle: 'full',
      timeStyle: 'short',
    })}</div>
    <div class="receipt-rule"></div>
    ${lines}
    <div class="receipt-rule"></div>
    <div class="receipt-line big"><span>TOTAL</span><span>${peso(sale.total)}</span></div>
    <div class="receipt-line"><span>Cash given</span><span>${peso(sale.paid)}</span></div>
    <div class="receipt-line"><span>Change</span><span>${peso(sale.change)}</span></div>
    <div class="receipt-thanks">Salamat po! Please come again.</div>`;
}

function showReceipt(sale, isNew) {
  $('#receiptPaper').innerHTML = receiptHtml(sale);
  $('#receiptChange').textContent = peso(sale.change);
  $('#changeBanner').hidden = false;
  $('#newSaleBtn').hidden = !isNew;
  openModal('modal-receipt');
}

$('#printBtn').addEventListener('click', () => window.print());
$('#viewPrintBtn').addEventListener('click', () => window.print());
$('#newSaleBtn').addEventListener('click', () => {
  closeModal('modal-receipt');
  focusScanner();
});

/* --------------------------------------------------------------- history */
function isToday(iso) {
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function updateToday() {
  const today = state.sales.filter((s) => isToday(s.at));
  $('#todayTotal').textContent = peso(today.reduce((sum, s) => sum + s.total, 0));
  $('#statSales').textContent = String(today.length);
  $('#statTotal').textContent = peso(today.reduce((sum, s) => sum + s.total, 0));
  $('#statItems').textContent = String(today.reduce((sum, s) => sum + (s.count || 0), 0));
}

function renderHistory() {
  updateToday();
  const list = $('#histList');
  if (!state.sales.length) {
    list.innerHTML = `<div class="empty-state"><span class="big">🧾</span>No sales yet today.<br />Finished sales appear here.</div>`;
    return;
  }
  list.innerHTML = state.sales
    .slice(0, 300)
    .map((sale) => {
      const when = new Date(sale.at);
      const label = isToday(sale.at)
        ? when.toLocaleTimeString('en-PH', { timeStyle: 'short' })
        : when.toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
      return `
      <div class="hist-row" data-id="${esc(sale.id)}">
        <div class="hist-when">${label}</div>
        <div class="hist-items">${sale.count || 0} item(s)</div>
        <div class="hist-total">${peso(sale.total)}</div>
        <button type="button" class="btn btn-ghost" data-act="view">See receipt</button>
      </div>`;
    })
    .join('');
}

$('#histList').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-act="view"]');
  if (!button) return;
  const row = button.closest('.hist-row');
  const sale = state.sales.find((s) => s.id === row.dataset.id);
  if (!sale) return;
  $('#viewPaper').innerHTML = receiptHtml(sale);
  openModal('modal-view');
});

/* --------------------------------------------------------------- settings */
$('#settingsBtn').addEventListener('click', () => {
  $('#sStoreName').value = state.settings.storeName;
  $('#sLowStock').value = state.settings.lowStock;
  openModal('modal-settings');
  setTimeout(() => $('#sStoreName').focus(), 30);
});

$('#settingsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  state.settings = await window.api.saveSettings({
    storeName: $('#sStoreName').value,
    lowStock: $('#sLowStock').value,
  });
  $('#storeName').textContent = state.settings.storeName;
  closeModal('modal-settings');
  renderInventory();
  toast('Settings saved.');
});

$('#muteBtn').addEventListener('click', () => {
  const muted = localStorage.getItem('pos-muted') === '1';
  localStorage.setItem('pos-muted', muted ? '0' : '1');
  $('#muteBtn').textContent = muted ? '🔊' : '🔇';
  toast(muted ? 'Beep sounds are on.' : 'Beep sounds are off.');
});

/* --------------------------------------------------------------- updates */
function updStatus(message, kind) {
  const el = $('#updStatus');
  if (!message) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = message;
  el.classList.toggle('is-error', kind === 'error');
  el.classList.toggle('is-ok', kind === 'ok');
}

// Each updater event becomes one plain sentence and one obvious next step.
window.api.onUpdateStatus(({ status, data }) => {
  const check = $('#updCheckBtn');
  const download = $('#updDownloadBtn');
  const install = $('#updInstallBtn');
  const progress = $('#updProgress');

  if (status === 'checking') {
    check.disabled = true;
    updStatus('Looking for a newer version…');
  } else if (status === 'available') {
    check.disabled = false;
    check.hidden = true;
    download.hidden = false;
    updStatus(`Version ${data.version} is ready to download.`, 'ok');
  } else if (status === 'not-available') {
    check.disabled = false;
    updStatus('You already have the newest version.', 'ok');
  } else if (status === 'downloading') {
    const percent = Math.max(0, Math.min(100, Math.round(data.percent || 0)));
    progress.hidden = false;
    $('#updFill').style.width = `${percent}%`;
    $('#updPercent').textContent = `${percent}%`;
    updStatus('Downloading the update…');
  } else if (status === 'downloaded') {
    progress.hidden = true;
    check.hidden = true;
    download.hidden = true;
    install.hidden = false;
    updStatus(`Version ${data.version} is ready. Press “Close and install”.`, 'ok');
    beep('done');
  } else if (status === 'error') {
    progress.hidden = true;
    check.hidden = false;
    check.disabled = false;
    download.hidden = true;
    install.hidden = true;
    updStatus(data, 'error');
  }
});

$('#updCheckBtn').addEventListener('click', () => window.api.checkForUpdates());
$('#updDownloadBtn').addEventListener('click', () => window.api.downloadUpdate());
$('#updInstallBtn').addEventListener('click', () => window.api.installUpdate());

/* ---------------------------------------------------------------- window */
// The window has no system title bar, so this ✕ in the header is the only
// way to close the app.
$('#closeBtn').addEventListener('click', () => window.api.closeWindow());

$('#confirmYes').addEventListener('click', () => settleConfirm(true));
$('#confirmNo').addEventListener('click', () => settleConfirm(false));

/* ---------------------------------------------------------------- startup */
async function init() {
  state.settings = await window.api.getSettings();
  $('#storeName').textContent = state.settings.storeName;
  $('#muteBtn').textContent = localStorage.getItem('pos-muted') === '1' ? '🔇' : '🔊';

  state.products = (await window.api.listProducts()) || [];
  state.sales = (await window.api.listSales(500)) || [];
  await refreshHolds();
  renderCart();
  updateToday();
  focusScanner();

  window.api
    .appVersion()
    .then((version) => {
      $('#updVersion').textContent = `You have version ${version}`;
    })
    .catch(() => {});

  if (!state.products.length) {
    setTimeout(
      () =>
        toast('Welcome! Start by adding your products in the Inventory tab.', {
          action: 'Add product',
          onAction: () => {
            showScreen('inventory');
            openProductForm();
          },
          duration: 12000,
        }),
      400
    );
  }
}

init().catch((err) => {
  toast(err.message || 'The app could not start.', { error: true, duration: 20000 });
});
