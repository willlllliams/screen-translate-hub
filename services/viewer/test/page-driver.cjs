// Headless browser for page.test.ts: loads STH_PAGE_URL offscreen, connects to the test
// on STH_DRIVER_PORT and runs each line it sends (JavaScript as a JSON string) in the
// page, answering with one JSON line each. A socket, because the Electron main process
// on Windows reads nothing from stdin; the URL comes in the environment because
// Electron on Windows exits at once when a command-line argument looks like a URL.
const { app, BrowserWindow } = require('electron');
const { connect } = require('node:net');
const readline = require('node:readline');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 412, height: 915, webPreferences: { offscreen: true, backgroundThrottling: false } });
  await win.loadURL(process.env.STH_PAGE_URL);
  const socket = connect(Number(process.env.STH_DRIVER_PORT), '127.0.0.1');
  readline.createInterface({ input: socket }).on('line', async (line) => {
    let reply;
    try {
      reply = { value: await win.webContents.executeJavaScript(JSON.parse(line)) };
    } catch (e) {
      reply = { error: String(e) };
    }
    socket.write(`${JSON.stringify(reply)}\n`);
  });
  socket.on('close', () => app.quit());
  socket.on('error', () => app.quit());
});
