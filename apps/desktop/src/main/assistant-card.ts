// AI card (spec 17 section 8): a small always-on-top window in a screen corner that
// never takes focus by itself. The hotkey gives its input the keyboard; sending a
// message (or Esc) hands the keyboard back to the window the user was in. The card
// relays between its page and an assistant.Session stream.
import type { Peer, Stream } from '@sth/wire';
import { BrowserWindow, ipcMain, screen } from 'electron';
import { join } from 'node:path';
import type { WindowEnv } from './host.ts';
import * as win32 from './win32.ts';

export interface AssistantOptions {
  heartbeat_ms: number;
  brain: string;
  gate: string;
}

type CardMessage = { kind: string; text?: string };

export class AssistantCard {
  private readonly env: WindowEnv;
  private readonly peer: () => Promise<Peer>;
  private readonly options: () => AssistantOptions;
  private win: BrowserWindow | null = null;
  private stream: Stream<Record<string, unknown>, Record<string, unknown>> | null = null;
  private previous = 0;
  private hasTask = false;

  constructor(env: WindowEnv, peer: () => Promise<Peer>, options: () => AssistantOptions) {
    this.env = env;
    this.peer = peer;
    this.options = options;
    ipcMain.on('sth', (e, msg: CardMessage) => {
      if (this.win && !this.win.isDestroyed() && e.sender === this.win.webContents) void this.onCard(msg);
    });
  }

  get isOpen(): boolean {
    return !!this.win && !this.win.isDestroyed();
  }

  window(): BrowserWindow | null {
    return this.isOpen ? this.win : null;
  }

  /** The hotkey: open the card and the session if needed, then give the input the keyboard. */
  async summon(): Promise<void> {
    const fg = win32.foregroundWindow();
    if (!this.isOpen) this.open();
    if (fg && win32.windowPid(fg) !== process.pid) this.previous = fg;
    void this.ensureSession();
    const win = this.win!;
    win.setFocusable(true);
    win.showInactive();
    win.focus();
    win.webContents.focus();
    win.webContents.send('sth', { kind: 'assistant-focus' });
  }

  private open(): void {
    const area = screen.getPrimaryDisplay().workArea;
    const width = 360;
    const height = 440;
    const win = new BrowserWindow({
      x: area.x + area.width - width - 16,
      y: area.y + area.height - height - 16,
      width,
      height,
      minWidth: 260,
      minHeight: 200,
      frame: false,
      resizable: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false, // never steals focus; the hotkey makes it focusable for a moment
      show: false,
      backgroundColor: '#1f2023',
      webPreferences: { preload: this.env.preload, contextIsolation: true, sandbox: false },
    });
    win.setAlwaysOnTop(true, 'floating');
    if (!this.env.debugCapturable) win.setContentProtection(true); // the AI never sees its own card
    void win.loadFile(join(this.env.rendererDir, 'assistant.html'));
    win.once('ready-to-show', () => win.showInactive());
    win.on('closed', () => {
      this.win = null;
      this.stopSession();
    });
    this.win = win;
  }

  private starting: Promise<void> | null = null;

  /** Open an assistant.Session unless one is running; resolves once it has been asked to start. */
  private ensureSession(): Promise<void> {
    if (this.stream && !this.stream.isFinished) return Promise.resolve();
    this.starting ??= new Promise<void>((ready) => void this.runSession(ready)).finally(() => (this.starting = null));
    return this.starting;
  }

  private async runSession(ready: () => void): Promise<void> {
    const o = this.options();
    try {
      const peer = await this.peer();
      const stream = peer.bidi<Record<string, unknown>, Record<string, unknown>>('assistant', 'Session', { deadlineMs: 0 });
      this.stream = stream;
      this.hasTask = false;
      await stream.send({ start: { task: '', heartbeat_ms: o.heartbeat_ms, brain: o.brain, gate: o.gate } });
      ready();
      for await (const m of stream) this.toCard({ kind: 'assistant', m });
    } catch (err) {
      ready();
      this.toCard({ kind: 'assistant', m: { brain: { type: 'turn_end', stop: 'error', error: `assistant service: ${(err as Error).message}` } } });
    }
    this.toCard({ kind: 'assistant', m: { state: { state: 'stopped' } } });
  }

  /** Send a message as if typed into the card (development control). */
  async ask(text: string): Promise<void> {
    if (!this.isOpen) this.open();
    await this.onCard({ kind: 'assistant-send', text });
  }

  private toCard(msg: unknown): void {
    if (this.isOpen) this.win!.webContents.send('sth', msg);
  }

  /** Give the keyboard back to the window the user was in. */
  private releaseFocus(): void {
    if (!this.isOpen) return;
    this.win!.setFocusable(false);
    if (this.previous) win32.setForeground(this.previous);
  }

  /** A button of the card, pressed through the dev control (pause, resume, clear, stop). */
  press(kind: 'assistant-pause' | 'assistant-resume' | 'assistant-clear' | 'assistant-stop'): Promise<void> {
    return this.onCard({ kind });
  }

  private async onCard(msg: CardMessage): Promise<void> {
    const s = this.stream;
    switch (msg.kind) {
      case 'assistant-send':
        await this.ensureSession();
        if (!this.hasTask && msg.text) {
          // the first thing the user says is the task of the session (spec 17 section 2)
          this.hasTask = true;
          await this.stream?.send({ set_task: { task: msg.text } }).catch(() => undefined);
        }
        await this.stream?.send({ user_message: { text: msg.text ?? '' } }).catch(() => undefined);
        this.releaseFocus();
        break;
      case 'assistant-blur':
        this.releaseFocus();
        break;
      case 'assistant-pause':
        await s?.send({ pause: {} }).catch(() => undefined);
        break;
      case 'assistant-resume':
        await s?.send({ resume: {} }).catch(() => undefined);
        break;
      case 'assistant-clear':
        await s?.send({ clear_annotations: {} }).catch(() => undefined);
        break;
      case 'assistant-stop':
        this.stopSession();
        this.win?.close();
        break;
    }
  }

  private stopSession(): void {
    const s = this.stream;
    this.stream = null;
    if (s && !s.isFinished) {
      void s.send({ stop: {} }).catch(() => undefined);
      s.halfClose();
    }
  }

  close(): void {
    this.stopSession();
    if (this.isOpen) this.win!.close();
  }
}
