// Drive the running desktop app through its dev control port (SSH testing).
//   node tools/dev/ctl.ts state
//   node tools/dev/ctl.ts screenshot 100 100 800 400
//   node tools/dev/ctl.ts continuous-start [display|follow_active_window|window_under_cursor]
//   node tools/dev/ctl.ts continuous-stop | details | dismiss | overlay-shots | viewer-link
//   node tools/dev/ctl.ts sharing on|off | interactive | overlay-toggle
//   node tools/dev/ctl.ts assistant [message]    (opens the AI card; with a message, sends it)
//   node tools/dev/ctl.ts assistant-card          (the card's state, status line and log)
//   node tools/dev/ctl.ts assistant-pause | assistant-resume | assistant-clear
//   node tools/dev/ctl.ts cards | cards-close      (floating screenshot cards)
//   node tools/dev/ctl.ts settings '{"display":{"mode":"dim"}}'   (or @patch.json from PowerShell)
//   node tools/dev/ctl.ts overlay-eval "document.body.innerHTML.length" [host index]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const cfg = JSON.parse(readFileSync(join(process.env.APPDATA ?? '', 'screen-translate-hub', 'dev-control.json'), 'utf8')) as { port: number; token: string };
const [action, ...rest] = process.argv.slice(2);
const body: Record<string, unknown> = { action };
if (action === 'screenshot') {
  const [x, y, w, h] = rest.map(Number);
  body.rect = { x, y, w, h };
} else if (action === 'continuous-start') body.mode = rest[0] ?? 'display';
else if (action === 'sharing') body.on = rest[0] !== 'off';
else if (action === 'assistant') body.text = rest.join(' ');
else if (action === 'details' && rest[0]) body.run_id = rest[0];
// '@file' reads the argument from a file (Windows PowerShell 5.1 strips quotes inside arguments)
const dropBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
const arg = (s: string) => (s.startsWith('@') ? dropBom(readFileSync(s.slice(1), 'utf8')) : s);
if (action === 'settings') body.patch = JSON.parse(arg(rest[0]));
else if (action === 'overlay-eval') {
  body.js = arg(rest[0]);
  body.index = Number(rest[1] ?? 0);
}

const res = await fetch(`http://127.0.0.1:${cfg.port}/`, { method: 'POST', headers: { 'x-sth-token': cfg.token }, body: JSON.stringify(body) });
const text = await res.text();
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(res.status, text);
}
