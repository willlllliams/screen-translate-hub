// Minimal Electron window probe: an opaque topmost red window and a transparent
// one with a green box. Usage: electron tools/dev/electron-probe.cjs [chromium switches]
const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  const opaque = new BrowserWindow({ x: 100, y: 100, width: 300, height: 200, backgroundColor: '#ff0000', alwaysOnTop: true, frame: false, show: true });
  opaque.loadURL('data:text/html,<body style="background:red;color:white;font:40px sans-serif">OPAQUE</body>');
  const transparent = new BrowserWindow({ x: 450, y: 100, width: 300, height: 200, transparent: true, frame: false, alwaysOnTop: true, show: true });
  transparent.loadURL('data:text/html,<body style="background:transparent;margin:0"><div style="margin:30px;width:200px;height:100px;background:rgba(0,160,0,.85);color:#fff;font:30px sans-serif">TRANSP</div></body>');
  console.log('gpu', JSON.stringify(app.getGPUFeatureStatus()));
  setTimeout(() => app.quit(), 20000);
});
