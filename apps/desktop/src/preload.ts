// Bridge between window pages and the main process. Pages get a minimal API:
// receive messages on one channel and send typed requests.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('sth', {
  on(cb: (msg: unknown) => void) {
    ipcRenderer.on('sth', (_e, msg) => cb(msg));
  },
  send(msg: unknown) {
    ipcRenderer.send('sth', msg);
  },
  invoke(msg: unknown) {
    return ipcRenderer.invoke('sth', msg);
  },
});
