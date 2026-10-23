// Offscreen rendering probe: counts paint events of a transparent offscreen page
// and how many pixels each frame covers, before and after a DOM change.
// Usage: electron tools/dev/osr-probe.cjs [chromium switches]
const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, width: 400, height: 200, transparent: true, frame: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
  win.webContents.setFrameRate(30);
  let n = 0;
  win.webContents.on('paint', (_e, dirty, image) => {
    n++;
    const bmp = image.toBitmap();
    let covered = 0;
    for (let i = 3; i < bmp.length; i += 4) if (bmp[i] > 0) covered++;
    console.log('paint', n, JSON.stringify(dirty), JSON.stringify(image.getSize()), 'covered', covered);
  });
  win.loadURL('data:text/html,<body style="background:transparent;margin:0"><div id=a style="margin:20px;width:100px;height:50px;background:rgba(0,160,0,.85)"></div><script>setTimeout(()=>requestAnimationFrame(()=>{document.getElementById("a").style.height="120px"}),2500)</script></body>');
  setTimeout(() => {
    console.log('dom change');
    win.webContents.executeJavaScript('document.getElementById("a").style.width="300px"');
  }, 1500);
  setTimeout(() => {
    console.log('total paints', n);
    app.quit();
  }, 4000);
});
