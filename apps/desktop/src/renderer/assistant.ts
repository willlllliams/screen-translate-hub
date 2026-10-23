// AI card (spec 17 section 8): session state, the AI's streamed answers, tool progress,
// and an input that gets keyboard focus only through the hotkey.
import { sth } from './bridge.ts';

type BrainEvent =
  | { type: 'status'; text: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool'; name: string; phase: 'start' | 'end'; ok?: boolean }
  | { type: 'turn_end'; stop: 'done' | 'error' | 'cancelled'; error?: string };

type ServerMessage =
  | { started: { session_id: string; brain: string; gate: string } }
  | { state: { state: string; reason?: string } }
  | { brain: BrainEvent }
  | { gate: { wake: boolean; reason: string; at: string } }
  | { say: { text: string; mode: 'replace' | 'append' } };

const log = document.getElementById('log')!;
const stateEl = document.getElementById('state')!;
const statusEl = document.getElementById('status')!;
const text = document.getElementById('text') as HTMLTextAreaElement;
const pauseBtn = document.getElementById('pause')!;
let state = 'starting';
let current: HTMLElement | null = null; // the answer being streamed
let tools: HTMLElement | null = null;
const TOOL_LABELS: Record<string, string> = {
  screen_capture: 'looked at the screen',
  screen_ocr: 'read the screen',
  translation_state: 'read the translations',
  annotate: 'drew on the screen',
  clear_annotations: 'cleared drawings',
  say: 'noted',
  get_context: 'checked the context',
};

function add(cls: string, content: string): HTMLElement {
  const d = document.createElement('div');
  d.className = `msg ${cls}`;
  d.textContent = content;
  log.appendChild(d);
  while (log.children.length > 200) log.firstElementChild?.remove();
  log.scrollTop = log.scrollHeight;
  return d;
}

function setState(s: string, reason?: string): void {
  state = s;
  stateEl.textContent = s;
  stateEl.className = s;
  pauseBtn.textContent = s === 'paused' ? 'Resume' : 'Pause';
  if (reason) statusEl.textContent = reason;
}

/** Plain text with **bold** spans, built from text nodes (the AI's text is never parsed as HTML). */
function renderInline(el: HTMLElement, s: string): void {
  el.dataset.raw = s;
  el.replaceChildren(
    ...s.split('**').map((part, i) => {
      if (i % 2 === 0) return document.createTextNode(part);
      const b = document.createElement('strong');
      b.textContent = part;
      return b;
    }),
  );
}

function onBrain(e: BrainEvent): void {
  if (e.type === 'text_delta') {
    current ??= add('ai', '');
    renderInline(current, (current.dataset.raw ?? '') + e.delta);
    log.scrollTop = log.scrollHeight;
  } else if (e.type === 'tool') {
    if (e.phase !== 'start') return;
    current = null; // text after the tool call is a new paragraph
    tools ??= (() => {
      const d = document.createElement('div');
      d.className = 'tools';
      log.appendChild(d);
      return d;
    })();
    const label = TOOL_LABELS[e.name] ?? e.name;
    if (!tools.textContent?.includes(label)) tools.textContent = tools.textContent ? `${tools.textContent} · ${label}` : label;
  } else if (e.type === 'turn_end') {
    // "-" is the AI's way of saying there was nothing worth mentioning after a heartbeat
    if (current && (current.dataset.raw ?? '').trim() === '-') current.remove();
    if (e.stop === 'error') add('err', `AI error: ${e.error ?? 'unknown'}`);
    current = null;
    tools = null;
  }
}

sth.on((raw) => {
  if (raw.kind === 'assistant-focus') {
    text.focus();
    return;
  }
  if (raw.kind !== 'assistant') return;
  const m = raw.m as ServerMessage;
  if ('started' in m) add('note', `Session started (${m.started.brain}, gate: ${m.started.gate}). I look at the screen now and then and speak up when something is worth it.`);
  else if ('state' in m) setState(m.state.state, m.state.reason);
  else if ('brain' in m) onBrain(m.brain);
  else if ('gate' in m) statusEl.textContent = `${new Date(m.gate.at).toLocaleTimeString()} · ${m.gate.wake ? 'looking: ' : ''}${m.gate.reason}`;
  else if ('say' in m) {
    if (m.say.mode === 'replace') log.replaceChildren();
    add('ai', m.say.text);
  }
});

function send(): void {
  const t = text.value.trim();
  if (!t) return;
  add('user', t);
  text.value = '';
  sth.send({ kind: 'assistant-send', text: t });
}

document.getElementById('send')!.addEventListener('click', send);
text.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  } else if (e.key === 'Escape') {
    sth.send({ kind: 'assistant-blur' });
  }
});
pauseBtn.addEventListener('click', () => sth.send({ kind: state === 'paused' ? 'assistant-resume' : 'assistant-pause' }));
document.getElementById('clear')!.addEventListener('click', () => sth.send({ kind: 'assistant-clear' }));
document.getElementById('stop')!.addEventListener('click', () => sth.send({ kind: 'assistant-stop' }));
