// Screenshot a web page at a phone-like size (offscreen, no desktop needed).
// Usage: set STH_PAGE_URL=<url>; electron tools/dev/page-shot.cjs <out.png> [waitMs] [width] [height] [scale] [js-to-run-before-shot]
// The URL goes in an environment variable: Electron on Windows exits at once when a
// command-line argument looks like a URL.
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');

const url = process.env.STH_PAGE_URL;
const [out, waitMs = '6000', width = '412', height = '915', scale = '2', js = ''] = process.argv.slice(2);
app.commandLine.appendSwitch('force-device-scale-factor', scale);

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, width: Number(width), height: Number(height), useContentSize: true, webPreferences: { offscreen: true } });
    win.webContents.on('console-message', (e) => console.log('page:', e.message));
    await win.loadURL(url);
    win.setContentSize(Number(width), Number(height)); // the first size is clamped to the work area
    await new Promise((r) => setTimeout(r, Number(waitMs)));
    if (js) {
      console.log('js:', await win.webContents.executeJavaScript(js));
      await new Promise((r) => setTimeout(r, Number(process.env.STH_AFTER_JS_MS ?? 800)));
    }
    const img = await win.webContents.capturePage();
    writeFileSync(out, img.toPNG());
    console.log('saved', out, JSON.stringify(img.getSize()));
  } catch (e) {
    console.error('page-shot failed:', e);
  }
  app.quit();
});
