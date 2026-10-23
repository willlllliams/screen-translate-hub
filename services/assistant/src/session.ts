// An assistant session (spec 17 sections 1 to 3): heartbeat, gate, one brain turn at a
// time. A wake during a turn waits in a single pending slot, newest first, except that
// a user's message is never replaced by a heartbeat wake.
import type { EncodedImage } from '@sth/model';
import { randomUUID } from 'node:crypto';
import type { Heartbeat } from './heartbeat.ts';
import type { Platform } from './platform.ts';
import { platformTools } from './tools.ts';
import type { Brain, Gate, GateDecision, PlatformTool, SessionServerMessage, SessionState, WakeEvent } from './types.ts';

export interface SessionDeps {
  platform: Platform;
  heartbeat: Heartbeat;
  gate: Gate;
  brain: Brain;
  heartbeatMs: number;
  emit(m: SessionServerMessage): void;
  log(...a: unknown[]): void;
}

export interface TranscriptEntry {
  at: string;
  who: 'user' | 'assistant' | 'heartbeat';
  text: string;
}

export class AssistantSession {
  readonly id: string;
  readonly tools: PlatformTool[];
  state: SessionState = 'idle';
  task: string;
  readonly transcript: TranscriptEntry[] = [];
  private readonly d: SessionDeps;
  private readonly wakeTimes: number[] = [];
  private lastWakeAt?: string;
  private lastFrame: EncodedImage | null = null;
  private pending: WakeEvent | null = null;
  private running: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sampling = false;
  private readonly gateLog: Array<GateDecision & { at: string }> = [];
  private lastGateReason = '';
  private answer = '';

  constructor(task: string, d: SessionDeps, id: string = randomUUID()) {
    this.id = id;
    this.task = task;
    this.d = d;
    this.tools = platformTools({
      platform: d.platform,
      task: () => this.task,
      recentGate: () => this.gateLog,
      say: (text, mode) => this.d.emit({ say: { text, mode } }),
    });
  }

  async start(): Promise<void> {
    await this.d.brain.open(this.task, this.tools);
    this.setState('watching');
    this.schedule();
  }

  private setState(s: SessionState, reason?: string): void {
    this.state = s;
    this.d.emit({ state: { state: s, reason } });
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.state === 'paused' || this.state === 'stopped') return;
    this.timer = setTimeout(() => void this.beat(), this.d.heartbeatMs);
  }

  /** One heartbeat: sample, ask the gate, maybe wake (spec 17 sections 3 and 4). */
  private async beat(): Promise<void> {
    if (this.sampling || this.state === 'paused' || this.state === 'stopped') return;
    this.sampling = true;
    try {
      const { sample, frame } = await this.d.heartbeat.sample();
      this.lastFrame = frame;
      const hourAgo = Date.now() - 3_600_000;
      while (this.wakeTimes.length && this.wakeTimes[0] < hourAgo) this.wakeTimes.shift();
      const decision = await this.d.gate.decide(
        { sample, task: this.task, paused: false, last_wake_at: this.lastWakeAt, wakes_last_hour: this.wakeTimes.length },
        AbortSignal.timeout(5_000),
      );
      const entry = { ...decision, at: sample.at };
      this.gateLog.push(entry);
      if (this.gateLog.length > 50) this.gateLog.shift();
      // the card's status line follows the gate, without repeating the same reason every beat
      if (decision.wake || decision.reason !== this.lastGateReason) this.d.emit({ gate: entry });
      this.lastGateReason = decision.reason;
      if (decision.wake && !this.running) this.wake({ kind: 'gate', decision, sample });
    } catch (err) {
      this.d.log('heartbeat failed:', (err as Error).message);
    } finally {
      this.sampling = false;
      this.schedule();
    }
  }

  /** Wake the brain now, or keep the wake for when the current turn ends. */
  wake(ev: WakeEvent): void {
    if (this.state === 'stopped') return;
    if (this.state === 'paused' && ev.kind !== 'user_message') return; // paused: no AI calls

    if (this.running) {
      if (ev.kind === 'user_message' && this.pending?.kind === 'user_message') this.pending = { ...ev, text: `${this.pending.text}\n${ev.text}` };
      else if (ev.kind === 'user_message' || this.pending?.kind !== 'user_message') this.pending = ev;
      return;
    }
    void this.runTurn(ev);
  }

  userMessage(text: string): void {
    if (!text.trim()) return;
    this.transcript.push({ at: new Date().toISOString(), who: 'user', text });
    if (this.state === 'paused') this.resume();
    this.wake({ kind: 'user_message', text });
  }

  private async runTurn(ev: WakeEvent): Promise<void> {
    const ctl = new AbortController();
    this.running = ctl;
    const now = new Date();
    this.wakeTimes.push(now.getTime());
    this.lastWakeAt = now.toISOString();
    this.d.heartbeat.markWake(this.lastFrame);
    if (ev.kind === 'gate') this.transcript.push({ at: now.toISOString(), who: 'heartbeat', text: ev.decision?.reason ?? '' });
    this.setState('thinking', ev.kind === 'gate' ? ev.decision?.reason : undefined);
    this.answer = '';
    try {
      for await (const e of this.d.brain.wake(ev, ctl.signal)) {
        if (e.type === 'text_delta') this.answer += e.delta;
        this.d.emit({ brain: e });
      }
    } catch (err) {
      this.d.emit({ brain: { type: 'turn_end', stop: ctl.signal.aborted ? 'cancelled' : 'error', error: (err as Error).message } });
    } finally {
      if (this.answer.trim()) this.transcript.push({ at: new Date().toISOString(), who: 'assistant', text: this.answer.trim() });
      this.running = null;
      if (this.state === 'thinking') this.setState('watching');
      const next = this.pending;
      this.pending = null;
      if (next && this.state === 'watching') void this.runTurn(next);
    }
  }

  /** Pause: no screenshots and no AI calls until resumed (requirement 09 section 4.2). */
  pause(): void {
    if (this.state === 'stopped' || this.state === 'paused') return;
    this.running?.abort();
    this.pending = null;
    if (this.timer) clearTimeout(this.timer);
    this.setState('paused');
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.setState('watching');
    this.schedule();
  }

  setTask(task: string): void {
    this.task = task;
    this.d.brain.setTask?.(task);
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped') return;
    if (this.timer) clearTimeout(this.timer);
    this.running?.abort();
    this.pending = null;
    this.setState('stopped');
    await this.d.brain.close().catch(() => undefined);
    await this.d.platform.close().catch(() => undefined);
  }
}
