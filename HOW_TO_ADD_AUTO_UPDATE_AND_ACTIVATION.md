# How to Add Auto-Update & App Activation to Your Next Electron App

A step-by-step implementation guide, based on the working implementation in the **Biometric DTR System**. Use this as a blueprint to add **Check for Updates (auto-update from GitHub Releases)** and **App Activation (license key)** to any new Electron app.

> **Prerequisites:** Node.js, an Electron app project, a GitHub repo, and (for activation) a free Cloudflare account.

---

## Table of Contents

1. [Project Setup](#1-project-setup)
2. [Part A: Auto-Update from GitHub Releases](#part-a-auto-update-from-github-releases)
   - A1. Install dependencies
   - A2. Configure `package.json` for electron-builder
   - A3. Add the auto-updater logic (main process)
   - A4. Add the update UI (renderer)
   - A5. Build & publish a release
   - A6. The critical `latest.yml` fix
3. [Part B: App Activation (License Server)](#part-b-app-activation-license-server)
   - B1. Create the license server (Cloudflare Worker)
   - B2. Configure Wrangler & KV
   - B3. Seed license keys
   - B4. Add the activation logic (main process)
   - B5. Add the activation UI (renderer)
4. [Testing Checklist](#testing-checklist)
5. [Key Files Reference](#key-files-reference)

---

## 1. Project Setup

Start with a standard Electron app. Minimum recommended versions:

```json
{
  "main": "src/main/main.js",
  "scripts": {
    "start": "electron .",
    "dist": "electron-builder --win"
  }
}
```

Create a folder structure similar to the reference app:

```
your-app/
├── package.json
├── src/
│   ├── main/
│   │   └── main.js          # Auto-updater + license logic
│   └── renderer/
│       ├── index.html
│       └── renderer.js      # Update + activation UI
├── build/
│   └── icon.ico             # App icon (required for Windows build)
└── license-server/          # Only needed for activation
    ├── src/index.js
    ├── seed.js
    └── wrangler.toml
```

---

# Part A: Auto-Update from GitHub Releases

## A1. Install Dependencies

```bash
npm install --save-dev electron electron-builder
npm install electron-updater
```

- **`electron-builder`** — packages your app into an installer.
- **`electron-updater`** — checks GitHub for new versions and downloads/installs them.

## A2. Configure `package.json` for electron-builder

Add the `build` section with a **`publish`** provider pointing at your GitHub repo:

```json
{
  "name": "your-app-name",
  "version": "1.0.0",
  "main": "src/main/main.js",
  "scripts": {
    "start": "electron .",
    "dist": "electron-builder --win"
  },
  "build": {
    "appId": "com.yourorg.yourapp",
    "productName": "Your App Name",
    "directories": { "output": "dist" },
    "files": ["src/**/*", "node_modules/**/*", "package.json"],
    "win": {
      "target": "nsis",
      "icon": "build/icon.ico",
      "signAndEditExecutable": false
    },
    "nsis": {
      "oneClick": false,
      "perMachine": true,
      "allowToChangeInstallationDirectory": true,
      "installerIcon": "build/icon.ico",
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true,
      "shortcutName": "Your App Name"
    },
    "publish": {
      "provider": "github",
      "owner": "YOUR_GITHUB_USERNAME",
      "repo": "YOUR_REPO_NAME",
      "releaseType": "release"
    }
  }
}
```

> **Important:** `publish.owner` and `publish.repo` must match your GitHub account/repo exactly. The auto-updater reads these to find releases.

## A3. Add the Auto-Updater Logic (Main Process)

In `src/main/main.js`, add the following. This is essentially the same logic used in the DTR app.

### 3.1 Import and configure

```js
const { app, BrowserWindow, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');

// Optional: load a GitHub token for private repos
function loadGithubToken() {
  try {
    const tokenFile = require('path').join(app.getPath('userData'), 'github_token.json');
    if (require('fs').existsSync(tokenFile)) {
      const data = JSON.parse(require('fs').readFileSync(tokenFile, 'utf-8'));
      if (data.token) {
        process.env.GH_TOKEN = data.token;
        return;
      }
    }
  } catch (_) {}
  // Public repos: clear stale token to avoid 401 errors
  delete process.env.GH_TOKEN;
}

autoUpdater.autoDownload = false;            // User clicks "Download"
autoUpdater.autoInstallOnAppQuit = true;     // Install on quit
```

### 3.2 Send status events to the renderer

```js
function sendUpdateStatus(status, data) {
  const win = BrowserWindow.getFocusedWindow();
  if (win) win.webContents.send('update-status', { status, data });
}

autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'));
autoUpdater.on('update-available', (info) => sendUpdateStatus('available', info));
autoUpdater.on('update-not-available', (info) => sendUpdateStatus('not-available', info));
autoUpdater.on('download-progress', (progress) => sendUpdateStatus('downloading', progress));
autoUpdater.on('update-downloaded', (info) => sendUpdateStatus('downloaded', info));
autoUpdater.on('error', (err) => sendUpdateStatus('error', err.message));
```

### 3.3 Expose IPC handlers

```js
ipcMain.handle('check-for-updates', async () => {
  try { autoUpdater.checkForUpdates(); return { success: true }; }
  catch (err) { return { success: false, message: err.message }; }
});

ipcMain.handle('download-update', async () => {
  try { autoUpdater.downloadUpdate(); return { success: true }; }
  catch (err) { return { success: false, message: err.message }; }
});

ipcMain.handle('install-update', async () => {
  autoUpdater.quitAndInstall();
  return { success: true };
});

// Optional: token management (for private repos)
ipcMain.handle('set-github-token', async (event, token) => {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(app.getPath('userData'), 'github_token.json');
  fs.writeFileSync(file, JSON.stringify({ token: token.trim(), updatedAt: new Date().toISOString() }, null, 2));
  process.env.GH_TOKEN = token.trim();
  return { success: true };
});
```

### 3.4 Load the token on app ready

```js
app.whenReady().then(() => {
  loadGithubToken();
  // ... createWindow() etc.
});
```

## A4. Add the Update UI (Renderer)

In `src/renderer/renderer.js`, add a "Check for Updates" section. Put this in an **About** or **Settings** view.

### HTML (in your view template)

```html
<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
  <button id="btn-check-updates">Check for Updates</button>
  <button id="btn-download-update" style="display:none;">Download Update</button>
  <button id="btn-install-update" style="display:none;">Restart & Install</button>
  <span id="update-status-text"></span>
</div>
<div id="update-progress-container" style="display:none;">
  <span id="update-progress-label">Downloading...</span>
  <span id="update-progress-percent">0%</span>
  <div id="update-progress-bar" style="width:0%;"></div>
</div>
```

### JavaScript

```js
const { ipcRenderer } = require('electron');
let appVersion = '1.0.0';

function setupUpdates() {
  // Fetch current version
  ipcRenderer.invoke('get-app-version').then(v => { appVersion = v; });

  const btnCheck = document.getElementById('btn-check-updates');
  const btnDownload = document.getElementById('btn-download-update');
  const btnInstall = document.getElementById('btn-install-update');
  const statusText = document.getElementById('update-status-text');
  const progressContainer = document.getElementById('update-progress-container');
  const progressBar = document.getElementById('update-progress-bar');
  const progressPercent = document.getElementById('update-progress-percent');

  ipcRenderer.on('update-status', (event, { status, data }) => {
    if (status === 'checking') {
      statusText.textContent = 'Checking for updates...';
      btnCheck.disabled = true;
    } else if (status === 'available') {
      statusText.textContent = `Update v${data.version} is available`;
      btnCheck.style.display = 'none';
      btnDownload.style.display = '';
    } else if (status === 'not-available') {
      statusText.textContent = `You're on the latest version (v${appVersion}).`;
      btnCheck.disabled = false;
    } else if (status === 'downloading') {
      progressContainer.style.display = '';
      const pct = Math.round(data.percent);
      progressBar.style.width = pct + '%';
      progressPercent.textContent = pct + '%';
      btnDownload.disabled = true;
    } else if (status === 'downloaded') {
      statusText.textContent = 'Update downloaded. Restart to install.';
      progressContainer.style.display = 'none';
      btnDownload.style.display = 'none';
      btnInstall.style.display = '';
    } else if (status === 'error') {
      statusText.textContent = 'Update error: ' + data;
      statusText.style.color = '#ef4444';
      btnCheck.disabled = false;
      btnCheck.style.display = '';
      btnDownload.style.display = 'none';
      btnInstall.style.display = 'none';
    }
  });

  btnCheck.addEventListener('click', () => ipcRenderer.invoke('check-for-updates'));
  btnDownload.addEventListener('click', () => ipcRenderer.invoke('download-update'));
  btnInstall.addEventListener('click', () => ipcRenderer.invoke('install-update'));
}
```

Also add the version IPC handler in main:

```js
ipcMain.handle('get-app-version', async () => app.getVersion());
```

## A5. Build & Publish a Release

### 5.1 Build the installer

```bash
npm run dist
```

This produces in `dist/`:
- `Your App Name Setup X.X.X.exe`
- `Your App Name Setup X.X.X.exe.blockmap`
- `latest.yml`

### 5.2 Create a GitHub release

```bash
gh release create vX.X.X ^
  "dist\Your App Name Setup X.X.X.exe" ^
  "dist\Your App Name Setup X.X.X.exe.blockmap" ^
  "dist\latest.yml" ^
  --repo YOUR_GITHUB_USERNAME/YOUR_REPO ^
  --title "vX.X.X" ^
  --notes "Release notes"
```

> The `latest.yml` file is what the running app reads to learn about new versions. It **must** be present in the release.

## A6. The Critical `latest.yml` Fix

**This is the #1 cause of "404 when downloading update" errors.**

electron-builder generates filenames with **spaces/hyphens**, but GitHub converts them to **dots** in the asset URL. The `latest.yml` must reference the **dot** version.

Open `dist/latest.yml` and ensure the `url` and `path` use dots:

```yaml
# Wrong (causes 404):
path: Your-App-Name-Setup-1.2.5.exe

# Correct:
path: Your.App.Name.Setup.1.2.5.exe
```

**If you ever change the version, delete the old release** before uploading the new one, otherwise GitHub may refuse the duplicate.

---

# Part B: App Activation (License Server)

## B1. Create the License Server (Cloudflare Worker)

This is a small server that validates license keys and tracks which machines have activated each key.

### `license-server/src/index.js`

```js
const ADMIN_SECRET = 'YOUR_STRONG_ADMIN_SECRET'; // Change this!

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') return cors(preflight());
    if (pathname === '/validate' && request.method === 'POST') return handleValidate(request, env);
    if (pathname === '/admin/add-key' && request.method === 'POST') return handleAddKey(request, env);
    if (pathname === '/admin/list-keys' && request.method === 'GET') return handleListKeys(request, env);
    if (pathname === '/admin/revoke' && request.method === 'POST') return handleRevoke(request, env);

    return cors(new Response('Not found', { status: 404 }));
  }
};

async function handleValidate(request, env) {
  const { key, machineId } = await request.json();
  if (!key || !machineId) {
    return cors(json({ valid: false, message: 'License key and machine ID required.' }));
  }

  const licenseStr = await env.LICENSE_KV.get(`license:${key}`);
  if (!licenseStr) return cors(json({ valid: false, message: 'Invalid license key.' }));

  const license = JSON.parse(licenseStr);
  if (license.revoked) return cors(json({ valid: false, message: 'This license key has been revoked.' }));
  if (license.expiresAt && new Date(license.expiresAt) < new Date()) {
    return cors(json({ valid: false, message: 'This license key has expired.' }));
  }

  // Machine already registered? Activate without consuming a new slot.
  const isRegistered = (license.activations || []).includes(machineId);
  if (!isRegistered && (license.activations || []).length >= (license.maxActivations || 1)) {
    return cors(json({ valid: false, message: `License already activated on ${license.activations.length} device(s).` }));
  }

  // Register the machine
  if (!isRegistered) {
    license.activations = license.activations || [];
    license.activations.push(machineId);
    await env.LICENSE_KV.put(`license:${key}`, JSON.stringify(license));
  }

  return cors(json({ valid: true, message: 'License activated successfully.', machineId }));
}

async function handleAddKey(request, env) {
  const { key, adminSecret, maxActivations, expiresAt } = await request.json();
  if (adminSecret !== ADMIN_SECRET) return cors(json({ success: false, message: 'Unauthorized.' }));

  const finalKey = key || generateKey();
  const existing = await env.LICENSE_KV.get(`license:${finalKey}`);
  if (existing) return cors(json({ success: false, message: 'Key already exists.' }));

  const license = {
    key: finalKey,
    maxActivations: maxActivations || 1,
    activations: [],
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt || null,
    revoked: false
  };
  await env.LICENSE_KV.put(`license:${finalKey}`, JSON.stringify(license));
  return cors(json({ success: true, key: finalKey }));
}

async function handleListKeys(request, env) {
  const adminSecret = request.headers.get('X-Admin-Secret');
  if (adminSecret !== ADMIN_SECRET) return cors(json({ success: false, message: 'Unauthorized.' }));

  const keys = [];
  let cursor;
  do {
    const result = await env.LICENSE_KV.list({ prefix: 'license:', cursor });
    for (const k of result.keys) {
      keys.push(JSON.parse(await env.LICENSE_KV.get(k.name)));
    }
    cursor = result.cursor;
  } while (cursor);
  return cors(json({ success: true, keys }));
}

async function handleRevoke(request, env) {
  const { key, adminSecret } = await request.json();
  if (adminSecret !== ADMIN_SECRET) return cors(json({ success: false, message: 'Unauthorized.' }));

  const licenseStr = await env.LICENSE_KV.get(`license:${key}`);
  if (!licenseStr) return cors(json({ success: false, message: 'Key not found.' }));

  const license = JSON.parse(licenseStr);
  license.revoked = true;
  await env.LICENSE_KV.put(`license:${key}`, JSON.stringify(license));
  return cors(json({ success: true, message: 'Key revoked.' }));
}

function generateKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const parts = [];
  for (let i = 0; i < 4; i++) {
    let part = '';
    for (let j = 0; j < 4; j++) part += chars[Math.floor(Math.random() * chars.length)];
    parts.push(part);
  }
  return 'YOURAPP-' + parts.join('-');
}

function json(data) {
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
}
function preflight() {
  return new Response(null, { headers: {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret'
  }});
}
function cors(res) {
  res.headers.set('Access-Control-Allow-Origin', '*');
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Secret');
  return res;
}
```

## B2. Configure Wrangler & KV

### `license-server/wrangler.toml`

```toml
name = "your-app-license-server"
main = "src/index.js"
compatibility_date = "2025-01-01"

kv_namespaces = [
  { binding = "LICENSE_KV", id = "REPLACE_WITH_YOUR_KV_ID" }
]
```

### Set up the KV namespace

```bash
npx wrangler login
npx wrangler kv:namespace create LICENSE_KV
```

Copy the returned ID into `wrangler.toml`.

### Deploy the worker

```bash
npx wrangler deploy
```

Note your worker URL (e.g. `https://your-app-license-server.xxxx.workers.dev`).

## B3. Seed License Keys

Create `license-server/seed.js`:

```js
const ADMIN_SECRET = process.argv[2];
const SERVER_URL = process.argv[3];

if (!ADMIN_SECRET || !SERVER_URL) {
  console.log('Usage: node seed.js <admin-secret> <server-url>');
  process.exit(1);
}

const KEYS_TO_ADD = [ { maxActivations: 1 }, { maxActivations: 1 }, { maxActivations: 1 } ];

async function run() {
  for (const opts of KEYS_TO_ADD) {
    const res = await fetch(`${SERVER_URL}/admin/add-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminSecret: ADMIN_SECRET, maxActivations: opts.maxActivations })
    });
    const data = await res.json();
    console.log(data.success ? '✓ License key: ' + data.key : '✗ Error: ' + data.message);
  }
}
run().catch(console.error);
```

Generate initial keys:

```bash
node seed.js YOUR_ADMIN_SECRET https://your-app-license-server.xxxx.workers.dev
```

Give **one key per customer** (each allows 1 machine by default).

## B4. Add the Activation Logic (Main Process)

Back in `src/main/main.js`, add the license client. This mirrors the DTR app's implementation.

### 4.1 Constants and helpers

```js
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');

const LICENSE_SERVER = 'https://your-app-license-server.xxxx.workers.dev';
const LICENSE_FILE = path.join(app.getPath('userData'), 'license.json');

// Generate a stable unique machine ID
function getMachineId() {
  const hash = crypto.createHash('sha256');
  hash.update(os.hostname());
  hash.update(os.userInfo().username);
  hash.update(os.platform());
  hash.update(os.arch());
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.mac && iface.mac !== '00:00:00:00:00:00') {
        hash.update(iface.mac);
        break;
      }
    }
    break;
  }
  return hash.digest('hex').substring(0, 16);
}

function getStoredLicense() {
  try {
    if (fs.existsSync(LICENSE_FILE)) return JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf-8'));
  } catch (_) {}
  return null;
}

function saveLicense(data) {
  fs.writeFileSync(LICENSE_FILE, JSON.stringify(data, null, 2));
}
```

### 4.2 IPC handlers

```js
ipcMain.handle('check-license', async () => {
  const stored = getStoredLicense();
  if (!stored || !stored.licenseKey || !stored.activatedAt) return { activated: false };
  return { activated: true, licenseKey: stored.licenseKey, machineId: getMachineId() };
});

ipcMain.handle('activate-license', async (event, licenseKey) => {
  try {
    const machineId = getMachineId();
    const response = await fetch(`${LICENSE_SERVER}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: licenseKey.trim().toUpperCase(), machineId })
    });
    const result = await response.json();

    if (result.valid) {
      saveLicense({
        licenseKey: licenseKey.trim().toUpperCase(),
        machineId,
        activatedAt: new Date().toISOString()
      });
    }
    return result;
  } catch (err) {
    return { valid: false, message: 'Cannot reach activation server. Check your internet connection.' };
  }
});

ipcMain.handle('get-machine-id', async () => getMachineId());
```

## B5. Add the Activation UI (Renderer)

### 5.1 Decide the flow on app start

In `renderer.js`, on `DOMContentLoaded`, check the license first. Show the **activation screen** if not activated, otherwise show **login/main**.

```js
document.addEventListener('DOMContentLoaded', async () => {
  const res = await ipcRenderer.invoke('check-license');
  if (res.activated) {
    showMainApp();      // your normal app
  } else {
    showActivation();   // show the activation screen
  }
});
```

### 5.2 Activation screen handler

```js
function showActivation() {
  // Show your activation overlay/form
  document.getElementById('activation-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = document.getElementById('activation-key').value.trim();
    const errEl = document.getElementById('activation-error');

    if (!key) { errEl.textContent = 'Please enter a license key.'; return; }

    const res = await ipcRenderer.invoke('activate-license', key);
    if (res.valid) {
      // Hide activation, show main app
      showMainApp();
    } else {
      errEl.textContent = res.message || 'Activation failed.';
    }
  });
}
```

### 5.3 HTML for the activation screen

```html
<div id="activation-overlay">
  <form id="activation-form">
    <h2>Activate Your App</h2>
    <input type="text" id="activation-key" placeholder="Enter license key (e.g. YOURAPP-XXXX-XXXX-XXXX)">
    <button type="submit">Activate</button>
    <p id="activation-error" style="color:red;"></p>
  </form>
</div>
```

---

## Testing Checklist

### Auto-Update
- [ ] `npm run dist` produces `.exe`, `.exe.blockmap`, `latest.yml`
- [ ] `latest.yml` uses **dots** in the filename
- [ ] Release uploaded with all 3 files to the correct GitHub repo
- [ ] Installed the previous version, then "Check for Updates" finds the new one
- [ ] Download progress bar updates
- [ ] "Restart & Install" opens the new version

### Activation
- [ ] License server deployed and reachable at your URL
- [ ] Keys seeded via `node seed.js`
- [ ] Fresh install shows the activation screen
- [ ] Entering a valid key activates the app on that machine
- [ ] Same key on a 2nd machine is blocked (if maxActivations = 1)
- [ ] Restarting the app skips activation (license.json cached)
- [ ] Revoking a key blocks re-activation

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `package.json` | Version, `electron-updater`, `electron-builder` & publish config |
| `src/main/main.js` | Auto-updater + license client IPC logic |
| `src/renderer/renderer.js` | Update & activation UI |
| `dist/latest.yml` | Update metadata (auto-generated, must be fixed for dots) |
| `license-server/src/index.js` | License validation server |
| `license-server/wrangler.toml` | Cloudflare Worker config + KV binding |
| `license-server/seed.js` | Initial key seeding |

---

## Quick Tips

1. **Always fix `latest.yml`** after building — replace hyphens with dots.
2. **Delete the old release** before uploading the same version again.
3. **Generate one license key per customer** with `maxActivations: 1` to prevent sharing.
4. **The machine ID is derived from hardware + user info** — reinstalling the OS changes it, so allow re-activation.
5. **Keep `LICENSE_SERVER` and `ADMIN_SECRET` out of source control** where possible (use environment variables / worker secrets).
