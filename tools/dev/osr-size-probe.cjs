// Offscreen window size probe: does a display-sized offscreen page keep its size?
// Usage: electron tools/dev/osr-size-probe.cjs
const { app, BrowserWindow, screen } = require('electron');

app.whenReady().then(async () => {
  const d = screen.getPrimaryDisplay();
  console.log('display', JSON.stringify(d.bounds), 'work', JSON.stringify(d.workArea), 'scale', d.scaleFactor);
  const variants = {
    plain: {},
    larger: { enableLargerThanScreen: true },
    largerContent: { enableLargerThanScreen: true, useContentSize: true },
  };
  for (const [name, extra] of Object.entries(variants)) {
    const win = new BrowserWindow({ show: false, width: d.bounds.width, height: d.bounds.height, transparent: true, frame: false, ...extra, webPreferences: { offscreen: true } });
    await win.loadURL('data:text/html,<body></body>');
    const inner = await win.webContents.executeJavaScript('[innerWidth, innerHeight]');
    let paint = null;
    win.webContents.once('paint', (_e, _r, img) => (paint = img.getSize()));
    win.setContentSize(d.bounds.width, d.bounds.height);
    await new Promise((r) => setTimeout(r, 300));
    const inner2 = await win.webContents.executeJavaScript('[innerWidth, innerHeight]');
    win.webContents.invalidate();
    await new Promise((r) => setTimeout(r, 300));
    console.log(name, 'bounds', JSON.stringify(win.getBounds()), 'inner', inner, 'after setContentSize', JSON.stringify(win.getContentSize()), inner2, 'paint', JSON.stringify(paint));
    win.destroy();
  }
  app.quit();
});
