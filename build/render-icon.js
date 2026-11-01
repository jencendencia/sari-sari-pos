// Photographs build/icon.html at 512 x 512 and writes build/_icon-raw.png.
//
// This runs the project's own Electron in a hidden, offscreen window, so the
// page is rendered by the same Chromium the app uses — real font shaping, real
// anti-aliasing — without a visible window and without the review pane's
// overlay landing in the picture. `node build/make-icon.js` takes it from there.
//
//   ./node_modules/.bin/electron build/render-icon.js
//   ./node_modules/.bin/electron build/render-icon.js --page build/specimen.html
//       --out build/_specimen.png --width 900 --height 1000

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const PAGE = path.resolve(arg('page', path.join(__dirname, 'icon.html')));
const OUT = path.resolve(arg('out', path.join(__dirname, '_icon-raw.png')));
const WIDTH = Number(arg('width', 512));
const HEIGHT = Number(arg('height', WIDTH));

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false, // never appears on screen
    frame: false,
    backgroundColor: '#123b36',
    webPreferences: {
      offscreen: true, // render without a visible surface
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  try {
    await win.loadFile(PAGE);
    // one quiet frame after layout so the webfont-less glyph has settled
    await new Promise((resolve) => setTimeout(resolve, 400));
    const image = await win.webContents.capturePage();
    const png = image.toPNG();
    if (!png || png.length < 1000) throw new Error('capture came back empty');
    fs.writeFileSync(OUT, png);
    console.log(`wrote ${path.relative(process.cwd(), OUT)} — ${png.length} bytes`);
  } catch (err) {
    console.error('render failed:', (err && err.message) || err);
    app.exit(1);
    return;
  }

  app.exit(0);
});

// A hidden window should never be able to hang the build.
setTimeout(() => {
  console.error('render timed out');
  app.exit(1);
}, 15000);
