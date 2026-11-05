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
  showHidden: false,
  scanHit: null,
  reportHtml: '',
  changeFund: 0,
  fundDay: '',
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
    // "No" is the safe answer, so it starts highlighted: a stray Enter or
    // Space press backs out instead of deleting anything.
    $('#confirmNo').focus();
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

// The arrow keys step between No and Yes, so the question can be answered
// without the mouse. There are only two buttons, so either direction toggles.
$('#modal-confirm').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  const onNo = document.activeElement === $('#confirmNo');
  (onNo ? $('#confirmYes') : $('#confirmNo')).focus();
});

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

// A dialog is never dismissed by a stray tap on the dark backdrop: a sale in
// progress or a half-typed product would be lost. Escape is the way out.
// It acts on the top-most dialog only — the last one left visible, since later
// dialogs stack over earlier ones — so a confirm opened over a form is
// answered first and the form stays open behind it.
function topModal() {
  const shown = $$('.modal-backdrop:not([hidden])');
  return shown.length ? shown[shown.length - 1] : null;
}

function escapeTopModal() {
  const modal = topModal();
  if (!modal) return false;
  // A confirm is waiting on an answer, so Escape has to answer it as "No" —
  // hiding it quietly would leave the caller waiting forever.
  if (modal.id === 'modal-confirm') settleConfirm(false);
  else modal.hidden = true;
  focusScanner();
  return true;
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' && event.key !== 'Esc') return;
  if (!escapeTopModal()) return;
  event.preventDefault();
  event.stopPropagation();
});

/* ------------------------------------------------------ keyboard shortcuts */
// Everything a busy counter needs has its own key, so a sale can be rung up
// without the mouse: F2 find an item, F3 check a price, F4 take payment,
// F5 freeze the sale, F6 the frozen sales, F10 cancel it — and F1 finishes the
// sale from inside the payment screen. Escape still backs out of what is open.
const sellScreenKeys = {
  F2: () => openPicker(),
  F3: () => openPriceCheck(),
  F4: () => $('#payBtn').click(),
  F5: () => freezeCurrentSale(),
  F6: () => openHolds(),
  F10: () => $('#clearCartBtn').click(),
};

document.addEventListener('keydown', (event) => {
  if (state.locked) return; // the activation screen owns the keyboard
  if (!/^F([1-9]|1[0-2])$/.test(event.key)) return;

  const modal = topModal();

  // In the payment screen F1 is the till key: take the money and finish.
  if (modal && modal.id === 'modal-pay') {
    if (event.key !== 'F1') return;
    event.preventDefault();
    if ($('#finishBtn').disabled) {
      beep('bad');
      toast('Type the cash the customer gave first.');
      return;
    }
    $('#finishBtn').click();
    return;
  }

  // The receipt takes the same key: F1 starts the next sale without reaching
  // for the mouse, which is the whole point at a busy counter.
  if (modal && modal.id === 'modal-receipt') {
    if (event.key !== 'F1') return;
    event.preventDefault();
    if (!$('#newSaleBtn').hidden) $('#newSaleBtn').click();
    return;
  }

  // Any other dialog (a form, a confirm, an old receipt) keeps its keys.
  if (modal || state.screen !== 'sell') return;

  const action = sellScreenKeys[event.key];
  if (!action) return;
  event.preventDefault();

  if (['F4', 'F5', 'F10'].includes(event.key) && !state.cart.length) {
    beep('bad');
    toast('The cart is empty.');
    return;
  }
  action();
});

function focusScanner() {
  if (state.screen !== 'sell') return;
  if ($$('.modal-backdrop:not([hidden])').length) return;
  $('#scanInput').focus();
}

/* -------------------------------------------------------------------- cart */
// Same rules as the main process: a product can carry a bundle offer ("3 for
// ₱5"), and a line is charged as whole bundles at that price plus whatever is
// left over at the single price. The offer travels with the cart line and then
// with the sale, so an old receipt still reads the way the customer paid.
function bundleOffer(line) {
  const qty = Math.round(Number(line && line.bundleQty) || 0);
  const price = Number(line && line.bundlePrice) || 0;
  if (qty < 2 || price <= 0) return null;
  return { qty, price };
}

function bundleSplit(line) {
  const offer = bundleOffer(line);
  const qty = Math.max(0, Math.round(Number(line && line.qty) || 0));
  if (!offer) return { offer: null, groups: 0, rest: qty };
  const groups = Math.floor(qty / offer.qty);
  return { offer, groups, rest: qty - groups * offer.qty };
}

function lineTotal(line) {
  const { offer, groups, rest } = bundleSplit(line);
  const unit = Number(line && line.price) || 0;
  const total = offer ? groups * offer.price + rest * unit : rest * unit;
  return Math.round(total * 100) / 100;
}

function cartUnitText(line) {
  const { offer, groups, rest } = bundleSplit(line);
  const unit = peso(Number(line.price) || 0);
  if (!offer) return `${unit} each`;
  const bundle = `${offer.qty} for ${peso(offer.price)}`;
  if (!groups) return `${unit} each · ${bundle}`;
  return rest ? `${bundle} + ${rest} × ${unit}` : bundle;
}

function cartTotal() {
  return Math.round(state.cart.reduce((sum, line) => sum + lineTotal(line), 0) * 100) / 100;
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
          <div class="cart-unit">${cartUnitText(line)}</div>
        </div>
        <div class="qty">
          <button type="button" data-act="minus" aria-label="One less">−</button>
          <span class="qty-value">${line.qty}</span>
          <button type="button" data-act="plus" aria-label="One more">+</button>
        </div>
        <div class="cart-end">
          <div class="cart-line-total">${peso(lineTotal(line))}</div>
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
      bundleQty: Number(product.bundleQty) || 0,
      bundlePrice: Number(product.bundlePrice) || 0,
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
  // Hidden items are not being sold, so the price checker leaves them out too.
  const visible = state.products.filter((p) => !p.hidden);

  const byCode = visible.find((p) => String(p.barcode || '').trim() === code);
  if (byCode) return [byCode];

  // A barcode half-typed by hand: let a few digits narrow it down.
  if (/^\d{3,}$/.test(code)) {
    const partial = visible.filter((p) => String(p.barcode || '').trim().startsWith(code));
    if (partial.length) return partial;
  }

  return visible.filter(
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
    bundleQty: Number(line.bundleQty) || 0,
    bundlePrice: Number(line.bundlePrice) || 0,
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

  // On the inventory screen a scan means "show me this item", not "sell it" —
  // the list changes instead of a line quietly landing in the cart.
  if (state.screen === 'inventory') {
    showScannedItem(code);
    return;
  }

  const product = findLocalProduct(code);
  if (product && product.hidden) {
    beep('bad');
    flash(false);
    toast(`${product.name} is hidden — press Show in Inventory if you want to sell it.`, {
      duration: 7000,
    });
    return focusScanner();
  }
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
  if (state.locked) return; // no scanning into an app that is not activated
  const active = document.activeElement;
  const typing =
    active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
  if (typing) return;

  // While the payment screen is up, the keyboard belongs to the cash box.
  if (!$('#modal-pay').hidden) return;

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
  if (name === 'reports') {
    if (!$('#repFrom').value || !$('#repTo').value) setReportPreset('month');
    else renderReports();
  }
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
    (p) =>
      !p.hidden && (!q || p.name.toLowerCase().includes(q) || String(p.barcode || '').includes(q))
  );
  const list = $('#pickerList');
  if (!matches.length) {
    const hiddenHit = state.products.find(
      (p) => p.hidden && (!q || p.name.toLowerCase().includes(q) || String(p.barcode || '').includes(q))
    );
    list.innerHTML = `<div class="empty-state">${
      hiddenHit
        ? `“${esc(hiddenHit.name)}” is hidden, so it cannot be sold.<br />Press <b>Hidden</b> in <b>Inventory</b> to bring it back.`
        : `No product matches “${esc(query)}”.<br />Add it in <b>Inventory</b> first.`
    }</div>`;
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
  pickProduct(button.dataset.id);
});

function pickProduct(id) {
  const product = state.products.find((p) => p.id === id);
  if (!product) return;
  closeModal('modal-picker');
  addToCart(product);
}

/* Arrow keys move a highlight through the matches; nothing is added to the cart
   until Enter lands on the highlighted row, so a sale can be rung up without
   reaching for the mouse but a stray key press cannot ring up the wrong item. */
function movePickerHighlight(step) {
  const items = $$('#pickerList .picker-item');
  if (!items.length) return;
  const current = items.findIndex((item) => item.classList.contains('is-on'));
  const index = current === -1 ? (step > 0 ? 0 : -1) : current + step;
  if (index < 0) {
    items.forEach((item) => item.classList.remove('is-on'));
    return;
  }
  const next = items[Math.min(index, items.length - 1)];
  items.forEach((item) => item.classList.toggle('is-on', item === next));
  next.scrollIntoView({ block: 'nearest' });
}

$('#pickerSearch').addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    movePickerHighlight(event.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (event.key !== 'Enter') return;
  const chosen = $('#pickerList').querySelector('.picker-item.is-on');
  if (!chosen) return;
  event.preventDefault();
  pickProduct(chosen.dataset.id);
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
  const hiddenCount = state.products.filter((p) => p.hidden).length;
  if (!hiddenCount) state.showHidden = false;

  // Hidden items stay out of the list until the shopkeeper asks for them,
  // except while searching: looking for a name on purpose should find it.
  const chip = $('#invHiddenBtn');
  chip.hidden = hiddenCount === 0;
  $('#invHiddenCount').textContent = hiddenCount;
  $('#invHiddenLabel').textContent = state.showHidden ? 'Show hidden' : 'Hidden';

  // A barcode scanned into the box leaves the box empty but shows its item on
  // its own. Typing takes the list back over, and an item that has since been
  // deleted drops the special view instead of showing an empty screen.
  if (q) state.scanHit = null;
  const scanned = state.scanHit ? state.products.find((p) => p.id === state.scanHit) : null;
  if (state.scanHit && !scanned) state.scanHit = null;
  $('#invFound').hidden = !state.scanHit;
  if (scanned) $('#invFoundText').textContent = `Scanned: ${scanned.name}`;

  const items = (state.scanHit
      ? state.products.filter((p) => p.id === state.scanHit)
      : state.products.filter(
          (p) =>
            (q || state.showHidden || !p.hidden) &&
            (!q || p.name.toLowerCase().includes(q) || String(p.barcode || '').toLowerCase().includes(q))
        )
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  // What the list adds up to. The stock a product holds decides its worth, so
  // every total here is the item's price multiplied by how many are on the
  // shelf — the same figure you would get by selling the lot. An item with no
  // original price is left out of the cost and profit sums rather than counted
  // as pure profit, which is the rule the day's takings already use.
  const held = (p) => Math.max(0, Number(p.stock) || 0);
  const priceOf = (p) => Number(p.price) || 0;
  const costOf = (p) => Number(p.originalPrice) || 0;
  const costed = items.filter((p) => costOf(p) > 0);
  const worth = (rows, f) => rows.reduce((sum, p) => sum + f(p) * held(p), 0);
  $('#invSumCount').textContent = String(items.length);
  $('#invSumOrig').textContent = peso(worth(costed, costOf));
  $('#invSumPrice').textContent = peso(worth(items, priceOf));
  $('#invSumProfit').textContent = costed.length
    ? peso(worth(costed, (p) => priceOf(p) - costOf(p)))
    : '—';

  const list = $('#invList');
  if (!items.length) {
    list.innerHTML = `<div class="empty-state"><span class="big">📦</span>${
      q
        ? `No product matches “${esc(q)}”.`
        : hiddenCount
          ? 'Every item is hidden.'
          : 'Your inventory is empty.'
    }${
      q || !hiddenCount
        ? '<br />Press <b>Add product</b> to put the first item in.'
        : '<br />Press <b>Hidden</b> above to bring them back.'
    }</div>`;
    return;
  }

  list.innerHTML = items
    .map((p) => {
      const pic = p.image
        ? `<img class="thumb" src="${esc(window.api.pictureUrl(p.image))}" alt="" />`
        : `<div class="thumb thumb-empty">🛒</div>`;
      const flag = stockFlagClass(p);
      return `
      <div class="inv-row${p.hidden ? ' is-hidden' : ''}" data-id="${esc(p.id)}">
        ${pic}
        <div>
          <div class="inv-name">${esc(p.name)}${p.hidden ? '<span class="inv-badge">Hidden</span>' : ''}</div>
          <div class="inv-meta">${p.barcode ? 'Barcode: ' + esc(p.barcode) : 'No barcode'}</div>
        </div>
        <div class="inv-price">
          ${peso(p.price)}
          ${
            Number(p.originalPrice) > 0
              ? `<div class="inv-orig">Original ${peso(p.originalPrice)}</div>`
              : ''
          }
          ${
            Number(p.bundleQty) >= 2 && Number(p.bundlePrice) > 0
              ? `<div class="inv-orig">${Number(p.bundleQty)} for ${peso(p.bundlePrice)}</div>`
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
        <div class="inv-actions">
          <button type="button" class="btn btn-ghost" data-act="edit">✏️ Edit</button>
          <button type="button" class="btn btn-ghost" data-act="hide">${
            p.hidden ? '👁 Show' : '🙈 Hide'
          }</button>
          <button type="button" class="btn btn-ghost btn-danger" data-act="delete" aria-label="Delete ${
            esc(p.name)
          }">🗑</button>
        </div>
      </div>`;
    })
    .join('');
}

$('#invSearch').addEventListener('input', renderInventory);

// The "Scanned: …" bar is the way back to the full list after a scan.
$('#invFoundClear').addEventListener('click', () => {
  state.scanHit = null;
  $('#invSearch').value = '';
  renderInventory();
  $('#invSearch').focus();
});

// A scanner types into whatever field has focus, so a barcode can land in this
// box — and the digits it leaves behind would stick to the next scan. Enter
// means "that was a scan": empty the box, bring the whole list back and say
// which item the code belongs to. Words ending in a few digits are left alone,
// so searching for a name still works normally.
// A scanner may send a UPC-A as 12 digits while the catalogue stored it as
// EAN-13 (or the other way round), and a code can arrive with spaces in it.
// Ignoring separators and leading zeros lets either form find the item.
function barcodeDigits(value) {
  return String(value == null ? '' : value)
    .replace(/[\s-]/g, '')
    .replace(/^0+/, '');
}

function matchBarcode(raw) {
  const plain = String(raw || '').replace(/[\s-]/g, '');
  const wanted = barcodeDigits(plain);
  if (wanted) {
    const byCode = state.products.find((p) => barcodeDigits(p.barcode) === wanted);
    if (byCode) return byCode;
  }
  if (!plain) return null;
  // a few items are stored with the code as their name
  return state.products.find((p) => String(p.name || '').includes(plain)) || null;
}

// One place decides what a barcode scanned on the Inventory screen means:
// show that item. The box is emptied for the next scan, the item appears on
// its own, and a bar above the list offers the way back to everything else.
function showScannedItem(raw) {
  const code = String(raw || '').replace(/[\s-]/g, '');
  const hit = matchBarcode(code);
  const box = $('#invSearch');
  box.value = '';
  if (hit) {
    state.scanHit = hit.id;
    renderInventory();
    beep('ok');
    toast(`Found in inventory: ${hit.name}`);
  } else {
    state.scanHit = null;
    renderInventory();
    beep('bad');
    toast(`No product in your inventory has barcode ${code}.`, { error: true, duration: 7000 });
  }
  box.focus();
}

$('#invSearch').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const raw = event.target.value;
  const typed = raw.match(/(\d{6,})\s*$/);
  const code = typed ? typed[1] : matchBarcode(raw) ? raw.trim() : '';
  if (!code) return;

  event.preventDefault();
  showScannedItem(code);
});
$('#invHiddenBtn').addEventListener('click', () => {
  state.showHidden = !state.showHidden;
  renderInventory();
});
$('#addProductBtn').addEventListener('click', () => openProductForm());

$('#invList').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-act]');
  if (!button) return;
  const row = button.closest('.inv-row');
  const product = state.products.find((p) => p.id === row.dataset.id);
  if (!product) return;

  if (button.dataset.act === 'edit') return openProductForm(product);

  if (button.dataset.act === 'hide') {
    const hidden = !product.hidden;
    const saved = await window.api.saveProduct({ ...product, hidden });
    const index = state.products.findIndex((p) => p.id === saved.id);
    if (index >= 0) state.products[index] = saved;
    renderInventory();
    toast(
      hidden
        ? `${saved.name} is hidden — it will not appear when you sell.`
        : `${saved.name} is back in the list.`
    );
    return;
  }

  if (button.dataset.act === 'delete') {
    const ok = await confirmBox(
      'Delete this item?',
      `${product.name} will be removed from your inventory. Past sales keep their own copy of the sale, but this cannot be undone.`,
      'Yes, delete'
    );
    if (!ok) return;
    await window.api.deleteProduct(product.id);
    state.products = state.products.filter((p) => p.id !== product.id);
    renderInventory();
    toast(`Deleted: ${product.name}`);
    focusScanner();
    return;
  }

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

// Proper case for a product name: the first letter of every word is
// capitalised and nothing else is touched, so brand spellings written in caps
// or with hyphens ("Coca-Cola", "3IN1") come through exactly as typed.
function properCaseName(text) {
  return String(text || '').replace(/(^|[\s(\[{,-])([a-z])/g, (match, before, letter) => before + letter.toUpperCase());
}

function openProductForm(product, scanBarcode) {
  state.editingId = product ? product.id : null;
  state.editingImage = product && product.image ? product.image : null;
  $('#productTitle').textContent = product ? `Edit: ${product.name}` : 'Add a product';
  $('#pName').value = product ? product.name : '';
  lastProductName = $('#pName').value;
  $('#pBarcode').value = product && product.barcode ? product.barcode : scanBarcode || '';
  lookupStatus('');
  // With the bundle switch on, the two price boxes describe the whole set, so
  // they are shown the way they were typed rather than as per-item figures.
  const bundleOn = !!(product && product.bundleQty >= 2 && product.bundlePrice > 0);
  $('#pPrice').value = !product ? '' : bundleOn ? product.bundlePrice : product.price;
  $('#pOriginal').value = !product || !product.originalPrice
    ? ''
    : bundleOn
      ? Math.round(product.originalPrice * product.bundleQty * 100) / 100
      : product.originalPrice;
  $('#pBundleOn').checked = bundleOn;
  $('#pBundleQty').value = bundleOn ? product.bundleQty : '';
  updateBundleForm();
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

// Show the proper case the moment the name field is left, so what is stored
// is what was seen.
$('#pName').addEventListener('blur', () => {
  const fixed = properCaseName($('#pName').value);
  if (fixed !== $('#pName').value) $('#pName').value = fixed;
});

// The form only ever shows two prices. Turning the bundle switch on relabels
// them as prices for the whole set and reveals how many go in one.
function updateBundleForm() {
  const on = $('#pBundleOn').checked;
  $('#bundleFields').hidden = !on;
  $('#pPriceLabel').textContent = on ? 'Bundle price (₱)' : 'Price (₱)';
  $('#pOriginalLabel').textContent = on ? 'Original bundle price (₱)' : 'Original price (₱)';
  $('#pPriceHint').textContent = on
    ? 'What the customer pays for the whole bundle'
    : 'What the customer pays';
  $('#pOrigHint').textContent = on
    ? 'What you paid for the whole bundle — your profit comes from this'
    : 'What you paid — your profit is worked out from this';
}

$('#pBundleOn').addEventListener('change', updateBundleForm);

$('#productForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#pName').value = properCaseName($('#pName').value); // Enter can skip blur
  const bundleOn = $('#pBundleOn').checked;
  const bundleQty = bundleOn ? Math.round(Number($('#pBundleQty').value) || 0) : 0;
  if (bundleOn && bundleQty < 2) {
    toast('A bundle needs at least 2 items — for example 3 for ₱5.', { error: true, duration: 6000 });
    $('#pBundleQty').focus();
    return;
  }
  // Both typed prices are for the whole bundle, so they are divided down to the
  // per-item figures the cart, the receipt and the profit all work with.
  const perItem = (amount) =>
    bundleOn ? Math.round((Number(amount) || 0) / bundleQty * 10000) / 10000 : amount;
  const payload = {
    id: state.editingId,
    name: $('#pName').value,
    barcode: $('#pBarcode').value,
    price: perItem($('#pPrice').value),
    originalPrice: perItem($('#pOriginal').value),
    bundleQty: bundleOn ? bundleQty : 0,
    bundlePrice: bundleOn ? Number($('#pPrice').value) || 0 : 0,
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

// The SRP line is appended to whatever the lookup is already saying, and the
// colour already on screen (a picture problem, say) is kept.
function appendLookupStatus(text) {
  const el = $('#lookupStatus');
  const keepError = el.classList.contains('is-error');
  const prefix = el.hidden ? '' : `${el.textContent.trim()} `;
  lookupStatus(`${prefix}${text}`, keepError ? 'error' : 'ok');
}

// What the internet knows about the price. A price already typed in the field
// is never touched — the shopkeeper's own figure always wins.
function applySrp(found) {
  const input = $('#pPrice');
  if (found.pesoPrice) {
    if (input.value) return '';
    input.value = String(found.pesoPrice);
    return `SRP from the internet: ${peso(found.pesoPrice)} — check it before you save.`;
  }
  if (input.value) return '';
  if (found.price) {
    return `The internet only has ${found.priceCurrency || 'USD'} ${Number(found.price).toFixed(2)} for this item — type the SRP in pesos.`;
  }
  return 'No price on the internet for this item — type the SRP.';
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
    const priceLine = applySrp(found);
    if (priceLine) appendLookupStatus(priceLine);
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

function openPayment() {
  if (!state.cart.length) return;
  state.cash = '';
  $('#payTotal').textContent = peso(cartTotal());
  renderPayment();
  openModal('modal-pay');
  // The cash box takes the cursor straight away, so the amount can be typed.
  setTimeout(() => $('#cashDisplay').focus(), 30);
}

$('#payBtn').addEventListener('click', openPayment);

$('#quickRow').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-quick]');
  if (!button) return;
  state.cash = button.dataset.quick === 'exact' ? String(cartTotal()) : button.dataset.quick;
  renderPayment();
  beep('ok');
});

// Tapping the keypad and typing on the number row feed the same amount: digits
// are appended, and one backspace takes the last one off again.
function pressCashKey(key) {
  if (key === 'back') state.cash = state.cash.slice(0, -1);
  else if (state.cash.length < 9) state.cash = (state.cash + key).replace(/^0+(?=\d)/, '');
  renderPayment();
}

$('#keypad').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-key]');
  if (!button) return;
  pressCashKey(button.dataset.key);
});

// The cash box holds the focus while payment is open, so the number row types
// the amount and Enter takes the money — no mouse, no tapping.
document.addEventListener('keydown', (event) => {
  if (topModal() !== $('#modal-pay')) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;

  if (/^\d$/.test(event.key)) pressCashKey(event.key);
  else if (event.key === 'Backspace') pressCashKey('back');
  else if (event.key === 'Enter') {
    event.preventDefault();
    finishSale();
    return;
  } else return;

  event.preventDefault();
});

// One basket is booked once: the button stays off while the save is in flight,
// so a double tap (or F1 pressed twice) cannot ring the same sale twice.
let finishingSale = false;

async function finishSale() {
  if (finishingSale || $('#finishBtn').disabled) return;
  finishingSale = true;
  $('#finishBtn').disabled = true;

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
  } finally {
    finishingSale = false;
    renderPayment();
  }
}

$('#finishBtn').addEventListener('click', finishSale);

/* -------------------------------------------------------------- receipts */
function receiptHtml(sale) {
  const when = new Date(sale.at);
  const lines = sale.items
    .map((line) => {
      const { offer, groups, rest } = bundleSplit(line);
      const unit = peso(line.price);
      const detail = offer
        ? [
            groups ? `${groups} × ${offer.qty} for ${peso(offer.price)}` : '',
            rest ? `${rest} × ${unit}` : '',
          ]
            .filter(Boolean)
            .join(' + ')
        : `${line.qty} × ${unit}`;
      return `
      <div class="receipt-line"><span>${esc(line.name)}</span><span>${peso(lineTotal(line))}</span></div>
      <div class="receipt-line qty"><span>&nbsp;&nbsp;${detail}</span><span></span></div>`;
    })
    .join('');

  return `
    <div class="receipt-store">${esc(state.settings.storeName)}</div>
    <div class="receipt-when">${when.toLocaleString('en-PH', {
      dateStyle: 'full',
      timeStyle: 'short',
    })}</div>
    <div class="receipt-rule"></div>
    ${sale.voided ? '<div class="receipt-void">VOIDED</div>' : ''}
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
  // A voided sale never happened as far as the day's takings go, so it is left
  // out of every figure here and in the header.
  const today = state.sales.filter((s) => !s.voided && isToday(s.at));
  $('#todayTotal').textContent = peso(today.reduce((sum, s) => sum + s.total, 0));
  $('#statSales').textContent = String(today.length);
  $('#statTotal').textContent = peso(today.reduce((sum, s) => sum + s.total, 0));
  $('#statItems').textContent = String(today.reduce((sum, s) => sum + (s.count || 0), 0));

  // Profit only counts the sales that know what they cost. Selling an item with
  // no original price is not free stock, so those sales are left out rather than
  // counted as pure profit.
  const priced = today.filter((s) => saleHasCost(s));
  $('#statProfit').textContent = priced.length
    ? peso(priced.reduce((sum, s) => sum + saleProfit(s), 0))
    : '—';
}

// Profit is selling price minus what the shop paid for the item — the "Original
// price" typed on the product — frozen onto the line on the day of the sale, so
// an old receipt keeps the profit it really made after prices change. Sales
// recorded while that figure was briefly called "cost" carry it under that name.
function lineCost(line) {
  const original = Number(line && line.originalPrice);
  if (original > 0) return original;
  return Math.max(0, Number(line && line.cost) || 0);
}

function saleHasCost(sale) {
  return (sale.items || []).some((line) => lineCost(line) > 0);
}

function saleProfit(sale) {
  const paid = (sale.items || []).reduce(
    (sum, line) => sum + lineCost(line) * (Number(line.qty) || 0),
    0
  );
  return Math.round((sale.total - paid) * 100) / 100;
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
      <div class="hist-row${sale.voided ? ' is-voided' : ''}" data-id="${esc(sale.id)}">
        <div class="hist-when">${label}</div>
        <div class="hist-items">${sale.count || 0} item(s)${
          sale.voided ? '<span class="void-tag">Voided</span>' : ''
        }</div>
        <div class="hist-money">
          <div class="hist-total">${peso(sale.total)}</div>
          ${
            !sale.voided && saleHasCost(sale)
              ? `<div class="hist-profit">${saleProfit(sale) < 0 ? '−' : ''}${peso(
                  Math.abs(saleProfit(sale))
                )} profit</div>`
              : ''
          }
        </div>
        <button type="button" class="btn btn-ghost" data-act="view">See receipt</button>
        ${
          sale.voided
            ? ''
            : '<button type="button" class="btn btn-ghost" data-act="void">Void sale</button>'
        }
      </div>`;
    })
    .join('');
}

$('#histList').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-act]');
  if (!button) return;
  const row = button.closest('.hist-row');
  const sale = state.sales.find((s) => s.id === row.dataset.id);
  if (!sale) return;
  if (button.dataset.act === 'void') {
    voidSale(sale);
    return;
  }
  $('#viewPaper').innerHTML = receiptHtml(sale);
  openModal('modal-view');
});

// Voiding puts the items back on the shelf and keeps the record, flagged: the
// day's takings stop counting it, but the shop can still see that it happened.
async function voidSale(sale) {
  const ok = await confirmBox(
    'Void this sale?',
    `${peso(sale.total)} — its ${sale.count || 0} item(s) go back into the inventory and the sale is marked voided.`,
    'Yes, void it'
  );
  if (!ok) return;
  try {
    const result = await window.api.voidSale(sale.id);
    sale.voided = true;
    // Stock moved on the main side, so the inventory in memory is now stale.
    state.products = (await window.api.listProducts()) || [];
    renderInventory();
    renderHistory();
    updateToday();
    beep('done');
    const back = `${(result && result.returned) || 0} item(s) back in stock`;
    toast(
      result && result.missing
        ? `Sale voided — ${back}. ${result.missing} item(s) are no longer in the inventory.`
        : `Sale voided — ${back}.`
    );
  } catch (err) {
    beep('bad');
    toast(err.message || 'The sale could not be voided.', { error: true, duration: 7000 });
  }
}

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

/* --------------------------------------------------------------- backup */
function backupStatus(message, kind) {
  const el = $('#backupStatus');
  if (!message) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = message;
  el.classList.toggle('is-error', kind === 'error');
  el.classList.toggle('is-ok', kind === 'ok');
}

function sizeText(bytes) {
  const kb = (Number(bytes) || 0) / 1024;
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(kb))} KB`;
}

$('#backupBtn').addEventListener('click', async () => {
  const button = $('#backupBtn');
  button.disabled = true;
  backupStatus('Making a copy of your database and pictures…');
  try {
    const result = await window.api.backupDatabase();
    const lines = [`Database (${sizeText(result.size)}): ${result.file}`];
    if (result.picturesZip) {
      lines.push(`Pictures — ${result.pictures} linked to items (${sizeText(result.picturesSize)}): ${result.picturesZip}`);
    } else {
      lines.push('Pictures: none are linked to an item yet, so no zip was made.');
    }
    if (result.missing) {
      lines.push(`${result.missing} linked picture(s) are missing on this computer and were left out.`);
    }
    $('#backupFolderBtn').hidden = false;
    backupStatus(lines.join('\n'), 'ok');
    beep('done');
    toast('Backup saved.');
  } catch (err) {
    backupStatus(`The backup could not be made: ${errText(err)}`, 'error');
    beep('bad');
  } finally {
    button.disabled = false;
  }
});

$('#backupFolderBtn').addEventListener('click', () => window.api.openBackupFolder());

// Restoring replaces everything, so it asks first and names what will go. The
// conversation with the file picker happens in the main process, which is also
// where the current data is copied aside before anything is overwritten.
$('#restoreBtn').addEventListener('click', async () => {
  const ok = await confirmBox(
    'Restore a backup?',
    'The products, sales and pictures in this app are replaced by the backup you choose. What is here now is copied into the Backups folder first, so it can be put back.',
    'Yes, choose the file'
  );
  if (!ok) return;

  const button = $('#restoreBtn');
  button.disabled = true;
  backupStatus('Choose the database from the backup, and its pictures zip if you have it…');
  try {
    const result = await window.api.restoreBackup();
    if (!result || result.canceled) {
      backupStatus('');
      return;
    }

    // The restored copy is the truth now: the basket may hold items that no
    // longer exist, so it is emptied before everything is read back.
    state.cart = [];
    await init();
    renderInventory();
    renderHistory();

    const lines = [
      `Restored ${result.products} product(s) and ${result.sales} sale(s) from ${result.file}`,
    ];
    if (result.pictures) {
      lines.push(
        `Pictures: ${result.pictures.saved} restored${
          result.pictures.skipped ? `, ${result.pictures.skipped} file(s) skipped` : ''
        }.`
      );
    } else {
      lines.push('Pictures: none chosen, so the pictures already here were kept.');
    }
    if (result.safety) lines.push(`Before the restore, saved here: ${result.safety}`);
    backupStatus(lines.join('\n'), 'ok');
    beep('done');
    toast('Backup restored.');
  } catch (err) {
    backupStatus(`The backup could not be restored: ${errText(err)}`, 'error');
    beep('bad');
  } finally {
    button.disabled = false;
  }
});

/* ---------------------------------------------------------------- window */
/* --------------------------------------------------------------- reports */
// Everything down to the "reports screen" line is pure: it takes sales and
// products and returns data plus a complete printable document, with no DOM.

const localIsoDate = (date) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
const endOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);

function presetRange(preset) {
  const now = new Date();
  if (preset === 'yesterday') {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    return { from: startOfDay(day), to: endOfDay(day) };
  }
  if (preset === 'week') {
    return {
      from: startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6)),
      to: endOfDay(now),
    };
  }
  if (preset === 'lastmonth') {
    return {
      from: startOfDay(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      to: endOfDay(new Date(now.getFullYear(), now.getMonth(), 0)),
    };
  }
  if (preset === 'month') {
    return {
      from: startOfDay(new Date(now.getFullYear(), now.getMonth(), 1)),
      to: endOfDay(now),
    };
  }
  return { from: startOfDay(now), to: endOfDay(now) };
}

function hourLabel(hour) {
  const suffix = hour < 12 ? 'am' : 'pm';
  const shown = hour % 12 === 0 ? 12 : hour % 12;
  return `${shown} ${suffix}`;
}

function aggregateReport(sales, products, from, to) {
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const all = Array.isArray(sales) ? sales : [];
  const live = all.filter((sale) => !sale.voided);

  const totals = { count: live.length, revenue: 0, items: 0, profit: 0, priced: 0 };
  const byProduct = new Map();
  const byHour = Array.from({ length: 24 }, () => ({ count: 0, revenue: 0 }));
  const byDay = new Map();

  for (const sale of live) {
    const profit = saleHasCost(sale) ? saleProfit(sale) : null;
    totals.revenue += sale.total || 0;
    totals.items += sale.count || 0;
    if (profit !== null) {
      totals.profit += profit;
      totals.priced += 1;
    }

    const when = new Date(sale.at);
    const dayKey = localIsoDate(when);
    const day = byDay.get(dayKey) || { count: 0, revenue: 0, profit: 0 };
    day.count += 1;
    day.revenue += sale.total || 0;
    if (profit !== null) day.profit += profit;
    byDay.set(dayKey, day);

    const hour = byHour[when.getHours()];
    hour.count += 1;
    hour.revenue += sale.total || 0;

    for (const line of sale.items || []) {
      const qty = Number(line.qty) || 0;
      const entry = byProduct.get(line.id) || {
        id: line.id,
        name: line.name || 'Unknown item',
        qty: 0,
        revenue: 0,
        cost: 0,
        known: false,
      };
      entry.qty += qty;
      entry.revenue += lineTotal(line);
      const paid = lineCost(line);
      if (paid > 0) {
        entry.cost += paid * qty;
        entry.known = true;
      }
      byProduct.set(line.id, entry);
    }
  }

  const best = [...byProduct.values()]
    .sort((a, b) => b.qty - a.qty || b.revenue - a.revenue)
    .slice(0, 15);

  // Items that still have stock and did not move at all in this range: that is
  // money asleep on the shelf.
  const slow = (Array.isArray(products) ? products : [])
    .filter((p) => !p.hidden && (Number(p.stock) || 0) > 0 && !byProduct.has(p.id))
    .map((p) => ({
      name: p.name,
      stock: Number(p.stock) || 0,
      value: round2((Number(p.stock) || 0) * (Number(p.price) || 0)),
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 15);

  const days = [];
  const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const last = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  while (cursor <= last) {
    const key = localIsoDate(cursor);
    const got = byDay.get(key);
    days.push({
      key,
      count: got ? got.count : 0,
      revenue: round2(got ? got.revenue : 0),
      profit: round2(got ? got.profit : 0),
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  const busiest = byHour.reduce((bestIndex, hour, index) =>
    hour.count > byHour[bestIndex].count ? index : bestIndex, 0);

  return {
    totals: {
      count: totals.count,
      revenue: round2(totals.revenue),
      items: totals.items,
      profit: round2(totals.profit),
      voided: all.length - live.length,
    },
    hasCost: totals.priced > 0,
    average: totals.count ? round2(totals.revenue / totals.count) : 0,
    best,
    slow,
    byHour,
    days,
    busiest,
  };
}

// One document, used twice: shown in the frame on screen, and handed to the PDF
// printer unchanged. It carries its own styles so the paper never depends on the
// app's dark theme.
// One document, used twice: shown in the frame on screen, and handed to the PDF
// printer unchanged. It carries its own styles, so the paper looks the same
// whether or not the shop has a connection when it is made.
//
// The sheet is laid out like the store's own tally book: the shop name set in a
// book serif, the money taken printed on the amber price-board strip, and the
// tables ruled in pine ink with tabular figures, so the columns line up the way
// they would in a written ledger.
// One document, used twice: shown in the frame on screen, and handed to the PDF
// printer unchanged. It carries its own styles, so the paper looks the same
// whether or not the shop has a connection when it is made.
//
// The sheet is laid out like the store's own tally book: the shop name set in a
// book serif, the money taken printed on the amber price-board strip, and the
// tables ruled in pine ink with tabular figures, so the columns line up the way
// they would in a written ledger.
function reportHtml({ from, to, data, storeName }) {
  const sameDay = localIsoDate(from) === localIsoDate(to);
  const rangeText = sameDay
    ? 'Sales on ' + from.toLocaleDateString('en-PH', { dateStyle: 'long' })
    : 'Sales from ' + `${from.toLocaleDateString('en-PH', { dateStyle: 'medium' })} to ${to.toLocaleDateString('en-PH', {
        dateStyle: 'medium',
      })}`;
  const generated = new Date().toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
  const dash = '<span class="dash">—</span>';
  const rule = '<span class="rule"></span>';

  const bestRows = data.best.length
    ? data.best
        .map(
          (item, index) => `
      <tr>
        <td class="rank">${index + 1}</td>
        <td>${esc(item.name)}</td>
        <td class="num">${item.qty}</td>
        <td class="num">${peso(item.revenue)}</td>
        <td class="num">${item.known ? peso(item.revenue - item.cost) : dash}</td>
      </tr>`
        )
        .join('')
    : '<tr><td colspan="5" class="none">Nothing was sold in this range.</td></tr>';

  const slowRows = data.slow.length
    ? data.slow
        .map(
          (item) => `
      <tr>
        <td>${esc(item.name)}</td>
        <td class="num">${item.stock}</td>
        <td class="num">${peso(item.value)}</td>
      </tr>`
        )
        .join('')
    : '<tr><td colspan="3" class="none">Everything with stock sold at least once.</td></tr>';

  const peak = data.byHour.reduce((max, hour) => Math.max(max, hour.revenue), 0) || 1;
  const hourRows = data.byHour
    .map((hour, index) =>
      hour.count
        ? `
      <tr>
        <td class="hour">${hourLabel(index)}</td>
        <td class="bar-cell"><span class="track"><span class="bar" style="width:${Math.max(2, Math.round((hour.revenue / peak) * 100))}%"></span></span></td>
        <td class="num">${hour.count}</td>
        <td class="num">${peso(hour.revenue)}</td>
      </tr>`
        : ''
    )
    .join('');

  const dayRows = data.days
    .map((day) => {
      const label = new Date(`${day.key}T00:00:00`).toLocaleDateString('en-PH', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      });
      return `
      <tr>
        <td>${esc(label)}</td>
        <td class="num">${day.count}</td>
        <td class="num">${peso(day.revenue)}</td>
        <td class="num">${data.hasCost ? peso(day.profit) : dash}</td>
      </tr>`;
    })
    .join('');

  const voidLine = data.totals.voided
    ? `${data.totals.voided} voided ${data.totals.voided === 1 ? 'sale' : 'sales'} left out`
    : 'No voided sales';
  const average = data.totals.count
    ? `about ${peso(data.average)} a sale`
    : 'nothing sold in this range';
  const profitNote = data.hasCost ? 'after what you paid' : 'no original prices yet';
  const busiest =
    data.byHour[data.busiest] && data.byHour[data.busiest].count
      ? `<span class="sub">Busiest at ${hourLabel(data.busiest)}</span>`
      : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${esc(storeName)} sales report</title>
<style>
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 20px 22px;
    font-family: "Segoe UI", system-ui, Arial, sans-serif;
    font-size: 10pt;
    line-height: 1.45;
    color: #14211f;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  h1, h2 { margin: 0; font-family: Georgia, "Times New Roman", serif; font-weight: 400; }

  .masthead { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; }
  .shop-name { font-size: 22pt; line-height: 1.05; letter-spacing: -0.015em; }
  .shop-line { margin: 4px 0 0; font-size: 10.5pt; color: #4a5c58; }
  .made { margin: 0; font-size: 8.5pt; line-height: 1.5; color: #6b7b78; text-align: right; white-space: nowrap; }

  /* The price-board strip from the app's own header: the one loud thing here. */
  .till {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    margin-top: 14px;
    padding: 10px 16px;
    background: #ffc24b;
    border-radius: 3px;
  }
  .till-taken { display: flex; flex-direction: column; }
  .till-label { font-size: 8.5pt; color: #6b4a00; }
  .till-money { font-size: 22pt; font-weight: 700; line-height: 1.05; color: #241a00; font-variant-numeric: tabular-nums; }
  .till-average { font-size: 8.5pt; color: #6b4a00; }
  .till-facts { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 24px; margin: 0; }
  .till-facts div { text-align: right; }
  .till-facts dt { font-size: 8.5pt; color: #6b4a00; }
  .till-facts dd { margin: 0; font-size: 13pt; font-weight: 700; line-height: 1.2; color: #241a00; font-variant-numeric: tabular-nums; }
  .fact-note { display: block; font-size: 8pt; font-weight: 400; color: #6b4a00; }

  h2 { display: flex; align-items: center; gap: 10px; margin: 22px 0 4px; font-size: 12.5pt; break-after: avoid; }
  h2 .sub { font-family: "Segoe UI", Arial, sans-serif; font-size: 8.5pt; color: #6b7b78; }
  .rule { flex: 1; height: 1px; background: #c3d1ce; }

  table { width: 100%; border-collapse: collapse; }
  thead th {
    padding: 4px 6px;
    font-size: 8.5pt;
    font-weight: 600;
    color: #4a5c58;
    text-align: left;
    border-bottom: 1.2px solid #0c2b29;
  }
  tbody td { padding: 5px 6px; border-bottom: 1px solid #e6eceb; }
  tbody tr:last-child td { border-bottom: 0; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  th.rank, td.rank { width: 24px; text-align: right; color: #93a29f; font-variant-numeric: tabular-nums; }
  tr { break-inside: avoid; }
  .none { padding: 8px 6px; color: #6b7b78; }
  .dash { color: #a9b6b3; }
  .hour { width: 58px; color: #4a5c58; font-variant-numeric: tabular-nums; }
  .bar-cell { width: 46%; }
  .track { display: block; height: 9px; background: #eef3f2; border-radius: 2px; }
  .bar { display: block; height: 9px; background: #0e8f5a; border-radius: 2px; }

  .foot { margin: 22px 0 0; padding-top: 8px; border-top: 1px solid #c3d1ce; font-size: 8pt; color: #6b7b78; }
</style>
</head>
<body>
  <header class="masthead">
    <div>
      <h1 class="shop-name">${esc(storeName)}</h1>
      <p class="shop-line">${esc(rangeText)}</p>
    </div>
    <p class="made">Made ${esc(generated)}<br />${esc(voidLine)}</p>
  </header>

  <section class="till">
    <div class="till-taken">
      <span class="till-label">Money taken</span>
      <span class="till-money">${peso(data.totals.revenue)}</span>
      <span class="till-average">${esc(average)}</span>
    </div>
    <dl class="till-facts">
      <div><dt>Sales</dt><dd>${data.totals.count}</dd></div>
      <div><dt>Items sold</dt><dd>${data.totals.items}</dd></div>
      <div><dt>Money for change</dt><dd>${peso(data.moneyForChange || 0)}</dd></div>
      <div><dt>Profit</dt><dd>${data.hasCost ? peso(data.totals.profit) : dash}<span class="fact-note">${esc(profitNote)}</span></dd></div>
    </dl>
  </section>

  <h2>Best sellers${rule}</h2>
  <table>
    <thead><tr><th class="rank">#</th><th>Item</th><th class="num">Sold</th><th class="num">Sales</th><th class="num">Profit</th></tr></thead>
    <tbody>${bestRows}</tbody>
  </table>

  <h2>Still on the shelf${rule}</h2>
  <table>
    <thead><tr><th>Item</th><th class="num">In stock</th><th class="num">Shelf value</th></tr></thead>
    <tbody>${slowRows}</tbody>
  </table>

  ${
    hourRows
      ? `<h2>Sales by hour${busiest}${rule}</h2>
  <table>
    <thead><tr><th>Hour</th><th></th><th class="num">Sales</th><th class="num">Money</th></tr></thead>
    <tbody>${hourRows}</tbody>
  </table>`
      : ''
  }

  ${
    data.days.length > 1
      ? `<h2>Day by day${rule}</h2>
  <table>
    <thead><tr><th>Day</th><th class="num">Sales</th><th class="num">Money</th><th class="num">Profit</th></tr></thead>
    <tbody>${dayRows}</tbody>
  </table>`
      : ''
  }

  <p class="foot">Made by Sari-Sari POS from the sales recorded in this app. Voided sales are kept out of every figure above.</p>
</body>
</html>`;
}

/* ------------------------------------------------------- reports screen */
/* ------------------------------------------------------- money for change */
// The float kept in the drawer to break big bills. It belongs to one day only:
// the figure is stored against today's date, so tomorrow starts at zero on its
// own without anyone having to clear yesterday's amount.
function renderChangeFund() {
  $('#changeFundAmount').textContent = peso(state.changeFund);
  $('#changeFundChip').title = state.changeFund
    ? `Money for change today: ${peso(state.changeFund)} — click to change it`
    : 'No money for change set today — click to set it';
}

async function loadChangeFund() {
  const day = localIsoDate(new Date());
  try {
    state.changeFund = Number(await window.api.getChangeFund(day)) || 0;
  } catch (err) {
    state.changeFund = 0;
  }
  state.fundDay = day;
  renderChangeFund();
}

function openChangeFund() {
  $('#fundAmount').value = state.changeFund ? state.changeFund : '';
  openModal('modal-fund');
  setTimeout(() => {
    $('#fundAmount').focus();
    $('#fundAmount').select();
  }, 30);
}

$('#changeFundChip').addEventListener('click', openChangeFund);

$('#fundForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const amount = Math.max(0, Math.round((Number($('#fundAmount').value) || 0) * 100) / 100);
  try {
    const saved = await window.api.setChangeFund(localIsoDate(new Date()), amount);
    state.changeFund = Number(saved && saved.amount) || 0;
    state.fundDay = (saved && saved.day) || localIsoDate(new Date());
    closeModal('modal-fund');
    renderChangeFund();
    toast(amount ? `Money for change today: ${peso(amount)}` : 'Money for change cleared.');
    renderReports(); // the report prints this figure, so keep it current
  } catch (err) {
    toast(errText(err), { error: true, duration: 7000 });
  }
});

// Midnight: a new day gets a fresh float, so the chip follows the calendar.
setInterval(() => {
  const today = localIsoDate(new Date());
  if (state.fundDay && state.fundDay !== today) loadChangeFund();
}, 60 * 1000);

let reportToken = 0;

function reportInputs() {
  const from = new Date(`${$('#repFrom').value}T00:00:00`);
  const to = new Date(`${$('#repTo').value}T00:00:00`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return { from: startOfDay(from), to: endOfDay(to) };
}

function setReportPreset(preset) {
  const range = presetRange(preset);
  $('#repFrom').value = localIsoDate(range.from);
  $('#repTo').value = localIsoDate(range.to);
  $$('.rep-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.preset === preset));
  renderReports();
}

// "1 sale", "5 sales", and the voided ones named only when there are some.
function describeSales(count, voided) {
  const sales = `${count} ${count === 1 ? 'sale' : 'sales'}`;
  return voided ? `${sales} · ${voided} voided left out` : sales;
}

async function renderReports() {
  const range = reportInputs();
  if (!range) {
    $('#repNote').textContent = 'Choose both dates.';
    return;
  }
  if (range.from > range.to) {
    $('#repNote').textContent = 'The \"from\" date is after the \"to\" date.';
    return;
  }

  const mine = ++reportToken;
  $('#repNote').textContent = 'Counting the sales…';
  try {
    const sales = (await window.api.salesBetween(range.from.toISOString(), range.to.toISOString())) || [];
    if (mine !== reportToken) return; // a newer range was asked for while this ran
    // The float is a per-day figure, so a range adds up the days it covers.
    const funds =
      (await window.api.changeFundBetween(localIsoDate(range.from), localIsoDate(range.to))) || [];
    if (mine !== reportToken) return;
    const data = aggregateReport(sales, state.products, range.from, range.to);
    data.moneyForChange = funds.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
    state.reportHtml = reportHtml({
      from: range.from,
      to: range.to,
      data,
      storeName: state.settings.storeName,
    });
    $('#reportFrame').srcdoc = state.reportHtml;
    $('#repNote').textContent = describeSales(sales.length, data.totals.voided);
  } catch (err) {
    $('#repNote').textContent = errText(err);
  }
}

$('#repPresets').addEventListener('click', (event) => {
  const chip = event.target.closest('.rep-chip');
  if (chip) setReportPreset(chip.dataset.preset);
});

['#repFrom', '#repTo'].forEach((selector) => {
  $(selector).addEventListener('change', () => {
    $$('.rep-chip').forEach((chip) => chip.classList.remove('active'));
    renderReports();
  });
});

// The PDF is made in the main process from the very same document shown in the
// frame, so the file and the screen can never disagree.
$('#repPdfBtn').addEventListener('click', async () => {
  if (!state.reportHtml) {
    toast('Open a report before saving it.');
    return;
  }
  const range = reportInputs();
  const name = range
    ? `Sari-Sari report ${localIsoDate(range.from)} to ${localIsoDate(range.to)}`
    : 'Sari-Sari report';
  const button = $('#repPdfBtn');
  button.disabled = true;
  try {
    const result = await window.api.saveReportPdf(state.reportHtml, name);
    if (result && result.canceled) return;
    beep('done');
    toast(`PDF saved: ${result.file}`, { duration: 10000 });
  } catch (err) {
    beep('bad');
    toast(errText(err), { error: true, duration: 7000 });
  } finally {
    button.disabled = false;
  }
});

// The window has no system title bar, so this ✕ in the header is the only
// way to close the app.
$('#closeBtn').addEventListener('click', () => window.api.closeWindow());

$('#confirmYes').addEventListener('click', () => settleConfirm(true));
$('#confirmNo').addEventListener('click', () => settleConfirm(false));

/* ------------------------------------------------------------- activation */
// The key screen is the only thing on offer until this copy is activated, so
// the keyboard shortcuts behind it are switched off while it is up.
function showActivation(status) {
  state.locked = true;
  $('#licenseMachineId').textContent = (status && status.machineId) || '—';
  $('#licenseScreen').hidden = false;
  $('#licenseKey').value = '';
  $('#licenseError').textContent = '';
  setTimeout(() => $('#licenseKey').focus(), 60);
}

// Keys are printed in capitals, so what is typed is shown in capitals too.
// main.js puts the dashes back whether or not they were typed.
$('#licenseKey').addEventListener('input', (event) => {
  const field = event.target;
  const caret = field.selectionStart;
  field.value = field.value.toUpperCase();
  field.setSelectionRange(caret, caret);
});

$('#licenseForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const key = $('#licenseKey').value.trim();
  const error = $('#licenseError');
  const button = $('#licenseBtn');

  if (!key) {
    error.textContent = 'Please type the license key that came with this copy.';
    $('#licenseKey').focus();
    return;
  }

  error.textContent = '';
  button.disabled = true;
  button.textContent = 'Checking…';

  try {
    const result = await window.api.activateLicense(key);
    if (result && result.valid) {
      state.locked = false;
      $('#licenseScreen').hidden = true;
      beep('done');
      await init();
      toast('Thank you — this copy is activated.', { duration: 6000 });
      return;
    }
    beep('bad');
    error.textContent = (result && result.message) || 'That license key could not be activated.';
  } catch (err) {
    error.textContent = errText(err);
  } finally {
    button.disabled = false;
    button.textContent = '🔓 Activate';
  }
});

/* ---------------------------------------------------------------- startup */
async function init() {
  state.settings = await window.api.getSettings();
  $('#storeName').textContent = state.settings.storeName;
  $('#muteBtn').textContent = localStorage.getItem('pos-muted') === '1' ? '🔇' : '🔊';

  state.products = (await window.api.listProducts()) || [];
  state.sales = (await window.api.listSales(500)) || [];
  await loadChangeFund();
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

async function start() {
  const status = await window.api.licenseStatus().catch(() => ({ activated: false }));
  if (status && status.activated) {
    state.locked = false;
    $('#licenseScreen').hidden = true;
    await init();
    return;
  }
  showActivation(status);
}

start().catch((err) => {
  toast(err.message || 'The app could not start.', { error: true, duration: 20000 });
});
