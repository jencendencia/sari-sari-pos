# Sari-Sari POS

A simple desktop point-of-sale for a small neighbourhood store. Built for one
person behind the counter: scan a barcode, take cash, give change — and keep
the stock list honest without typing much.

## What it does

**Sell (the screen it opens on)**
- The barcode scanner field is always ready. Scan an item and it lands in the
  cart with its name, price and picture.
- A scanner is just a fast keyboard, so scanning also works when the field is
  not clicked first.
- Unknown barcode? The app asks whether to add it as a new product right away.
- No barcode on the item (sachets, loose goods)? Press **Find item by name**.
- Quantity with big + / − buttons. Every line has its own **✕ Remove** button,
  for when the customer changes their mind about one item — the total updates
  at once, stock is untouched (nothing is sold until *Take payment*), and an
  **Undo** toast appears so a mis-tap is never a disaster. Tapping **−** on a
  quantity of 1 removes that line too.
- **Take payment** opens the cash screen: big keypad, one-tap shortcuts for
  ₱50/₱100/₱200/₱500/₱1,000 and *Exact*, then the **change due** in the
  largest type on the screen. Finishing the sale prints a receipt and reduces
  stock automatically.
- **🏷️ Check price** answers “magkano ‘to?” without touching the sale. Scan a
  barcode **or type part of the item name** — the name, price and stock appear
  in big type. A few digits of a barcode also work. When several items match,
  they are listed underneath and tapping one shows its price. Nothing is added
  to the cart and no stock is touched.
- **🧊 Freeze this sale** parks the current cart so you can serve someone else.
  A frozen sale is stored in the database with its own button in **Frozen
  sales** (the badge counts them); **Bring back** puts the items and quantities
  straight back in the cart, or **Delete** throws it away. Stock is only
  reduced when a sale is finished, never when it is frozen.

**Inventory**
- Every product with name, barcode, price, stock on hand and picture.
- **Original price (₱)** — what the shop paid for the item — is typed right
  beside the selling price when adding or editing a product. It shows in the
  inventory list under the price, and is **never shown on the Sell screen**:
  the cart, the receipt and the price checker only ever use the selling price.
  Leave it empty and no extra line appears.
- Scanning a barcode that is not in the inventory **looks it up online**: the
  name, brand, size and a product picture are filled in, so only the price has
  to be typed. The same works with the **🔎 Look up** button in the product
  form. It tries free, keyless catalogues in this order — Open Food Facts,
  Open Beauty Facts, Open Products Facts, then a general UPC catalogue — and
  says plainly when nothing is online.
- Stock shows a plain-English flag: *In stock*, *Running low*, *Out of stock*.
- ± buttons adjust stock without opening the product.
- Pictures come from three places: **find one on the internet** (searches free
  photo libraries and saves the picture into the app), **paste a picture link**
  and download it, or **choose a file from this computer**.
- The picture a barcode lookup finds is downloaded for you, and it retries once
  before giving up — a dropped connection is what usually makes it fail. If it
  still cannot get through, the reason is shown in plain words (*the website
  answered 404*, *no answer from the website*) and the app **searches pictures
  for that product automatically**, so you only have to tap the one you like.

**Sales**
- Today's money, number of sales and items sold, plus a list of finished sales.
- Any receipt can be reopened and printed again.

**Store settings** (⚙️ in the top bar) sets the store name printed on receipts
and the low-stock warning level.

**Updates**
- Also in ⚙️ Store settings: **🔄 Check for updates**. The installed app asks
  the GitHub release whether a newer version exists and answers in plain words
  (*You already have the newest version.* / *Version 1.1.0 is ready to
  download.*). Nothing is downloaded until the button is pressed, a progress
  bar shows the download, and **🔁 Close and install** restarts the app on the
  new version — closing the app after a finished download installs it too. The
  version you are running is shown above the button.

## Running it

```
npm install
npm start
```

To build the Windows installer (`dist/SariSariPOS.Setup.<version>.exe`, plus
its `.blockmap` and `latest.yml`):

```
npm run dist
```

The installer name is deliberately dot-separated with no spaces: GitHub keeps
asset names as they are, so `latest.yml` can never point at a filename that
404s — the usual cause of failed auto-updates. Publishing a release uploads
those three files:

```
gh release create v<version> \
  "dist/SariSariPOS.Setup.<version>.exe" \
  "dist/SariSariPOS.Setup.<version>.exe.blockmap" \
  "dist/latest.yml" \
  --repo jencendencia/sari-sari-pos \
  --title "v<version>" --notes "..."
```

Requirements: Node.js 18+ and a USB or Bluetooth barcode scanner that types
into the keyboard (almost all of them do).

## How it's built

| File | Role |
| --- | --- |
| `main.js` | Electron main process: window, SQLite data store, picture search/download, auto-updater |
| `preload.js` | The small, explicit API the window is allowed to use |
| `src/index.html` | The three screens and dialogs |
| `src/styles.css` | The visual design: pine & amber counter theme |
| `src/app.js` | Cart, scanning, payment, inventory, receipts and update UI |

Data lives in a **SQLite database** (`sari-pos.db`) inside the app's own data
folder, and pictures are kept beside it — nothing is deleted or overwritten
elsewhere on the computer. SQLite runs through `node-sqlite3-wasm`, so there is
no native compiler to install; it writes a normal `.db` file that can be opened
with any SQLite tool. A JSON file from an earlier version is imported once on
first start and then renamed to `sari-pos.json.migrated` as a backup. Tables:
`products`, `sales` (the line items are stored as JSON in the sale row) and
`settings`.

## Design notes

The interface is built for an older user reading at arm's length: 17px base
text, money at 38–44px, every button at least 46px tall, three fixed tabs that
never move, colour always paired with a word, and no destructive action without
a confirmation. The typeface is Atkinson Hyperlegible, designed for low vision
(with a system fallback when offline).

The palette is "pine & amber": deep pine chrome (`#0c2b29`) frames the screen
top and bottom like a sari-sari store's painted steel grille, amber (`#ffc24b`)
is spent only on money and on the active tab the way a price board spends
yellow, jade (`#0e8f5a`) means go, and red (`#c0271b`) means stop. Everything
else is a cool porcelain neutral so the numbers stay the loudest thing on
screen. All values live as tokens at the top of `styles.css`.
