// One run (spec 04 sections 2, 3, 8, 9, 11).
import {
  hasWords,
  sameLanguage,
  toRelativeQuad,
  toRelativeRect,
  type CaptureGeometry,
  type CaptureRange,
  type DisplaySnapshot,
  type EndState,
  type Image,
  type OcrResult,
  type Rect,
  type Unit,
  type Via,
} from '@sth/model';
import type { Peer } from '@sth/wire';
import type { WorkflowDoc } from '@sth/workflow';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Availability } from './availability.ts';
import { TranslationCache } from './cache.ts';
import { CaptureClient, type CaptureBatch } from './capture-client.ts';
import type { Clients } from './clients.ts';
import { RunDetails } from './details.ts';
import { DisplayHub, type DisplayStream } from './display.ts';
import { SourceDispatcher } from './dispatch.ts';
import { detectLanguage } from './langid.ts';
import { compilePlan, PreflightError } from './plan.ts';
import type { ServiceQueue } from './queue.ts';
import { Race, type RaceSink, type ShowBody } from './race.ts';
import { dropDuplicates, matchHeld, planReuse, type PrevBatch } from './reuse.ts';
import { cardSink, overlaySink, viewerSink } from './sinks.ts';
import type { ExecPlan, ResolvedService } from './types.ts';

export type RunStatusName = 'preparing' | 'running' | 'paused' | 'completed' | 'stopped' | 'failed';

export interface RunStart {
  run_id: string;
  workflow: WorkflowDoc | string | Uint8Array;
  entry: string;
  device_id: string;
  continuous_range?: CaptureRange;
  /** v1: the screenshot taken by the agent when the user started selecting (spec 18). */
  image?: Image;
  anchor?: { x: number; y: number };
  range_label?: string;
}

export type Control =
  | { pause: true }
  | { resume: true }
  | { stop: true }
  | { cancel: { node_id: string } }
  | { retry: { node_id: string } };

export interface RunHooks {
  status(state: RunStatusName, reason?: string): void;
  notify(kind: string, text: string): void;
  preflightFailed(node: string, problem: string): void;
}

export interface Shared {
  availability: Availability;
  queueFor(svc: ResolvedService): ServiceQueue;
}

interface BatchCtx {
  seq: number;
  deadline: number;
  W: number;
  H: number;
  units: Unit[];
  races: Map<number, Race>;
  dispatchers: Map<string, SourceDispatcher>;
  pending: Set<number>;
  allDone: () => void;
  done: Promise<void>;
  abort: AbortController;
  ended: boolean;
}

function decodeWorkflow(w: RunStart['workflow']): WorkflowDoc {
  if (typeof w === 'string') return JSON.parse(w) as WorkflowDoc;
  if (w instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(w)) as WorkflowDoc;
  return w;
}

function cropBGRA(img: Image, r: Rect): Image['image'] {
  const src = img.image;
  if (src.format !== 'raw_bgra8') throw new Error(`v1 coordinator expects raw_bgra8 frames, got ${src.format}`);
  const out = new Uint8Array(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) {
    const from = ((r.y + y) * src.width + r.x) * 4;
    out.set(src.data.subarray(from, from + r.w * 4), y * r.w * 4);
  }
  return { format: 'raw_bgra8', width: r.w, height: r.h, data: out };
}

export class Run implements RaceSink {
  readonly id: string;
  readonly start: RunStart;
  readonly details = new RunDetails();
  state: RunStatusName = 'preparing';
  plan!: ExecPlan;
  private readonly clients: Clients;
  private readonly hooks: RunHooks;
  private readonly shared: Shared;
  private doc!: WorkflowDoc;
  private hub!: DisplayHub;
  private cache!: TranslationCache;
  private ocrPeer!: Peer;
  private normPeer!: Peer;
  private readonly sourcePeers = new Map<string, Peer>();
  private capture: CaptureClient | null = null;
  private batchSeq = 0;
  private prev: PrevBatch | null = null;
  private ocrDone = true;
  private current: BatchCtx | null = null;
  private last: BatchCtx | null = null;
  private resumeWaiters: Array<() => void> = [];
  private readonly noticeActive = new Set<string>();
  /** Whether screen sharing is on (spec 05 requirement section 4.3), as last reported by the agent. */
  private sharing = false;
  private viewer: ResolvedService | null = null;
  private finished!: () => void;
  readonly ended = new Promise<void>((r) => (this.finished = r));

  constructor(start: RunStart, clients: Clients, hooks: RunHooks, shared: Shared) {
    this.id = start.run_id;
    this.start = start;
    this.clients = clients;
    this.hooks = hooks;
    this.shared = shared;
  }

  /** The overlay display state of this run, for the assistant's translation_state tool (spec 17 section 6). */
  displaySnapshot(): DisplaySnapshot | null {
    if (!this.hub) return null;
    const s = this.hub.byType('overlay')[0] ?? this.hub.streams[0];
    return s ? s.snapshot() : null;
  }

  private setState(s: RunStatusName, reason?: string): void {
    this.state = s;
    this.hooks.status(s, reason);
    if (s === 'completed' || s === 'stopped' || s === 'failed') this.finished();
  }

  // ---------------- preparing (spec 04 section 2.2) ----------------

  async prepare(): Promise<boolean> {
    this.hooks.status('preparing');
    try {
      this.doc = decodeWorkflow(this.start.workflow);
      const resolved = new Map<string, ResolvedService>();
      this.plan = await compilePlan(
        this.doc,
        async (node, def) => {
          const name = node.binding?.service ?? def;
          if (node.binding && node.binding.location !== 'local') throw new PreflightError(node.id, `location ${node.binding.location} is not available in v1`);
          if (!name) throw new PreflightError(node.id, 'no service configured');
          const hit = resolved.get(name);
          if (hit) return hit;
          try {
            const svc = await this.clients.acquire(name);
            resolved.set(name, svc);
            return svc;
          } catch (e) {
            throw new PreflightError(node.id, `service ${name} unavailable: ${(e as Error).message}`);
          }
        },
        this.start.continuous_range,
      );
      this.ocrPeer = await this.clients.peer(this.plan.ocr.service);
      this.normPeer = await this.clients.peer(this.plan.normalize.service);
      for (const s of this.plan.race?.sources ?? []) this.sourcePeers.set(s.node, await this.clients.peer(s.service));
      this.cache = new TranslationCache(this.plan.params.cacheCapacity);
      this.hub = new DisplayHub(this.id, this.plan.outputs);
      this.attachSinks();
      this.shared.availability.onChange((svc, available, reason) => this.onAvailability(svc, available, reason));
      return true;
    } catch (e) {
      const node = e instanceof PreflightError ? e.node : 'workflow';
      this.hooks.preflightFailed(node, (e as Error).message);
      this.details.push({ kind: 'preflight_failed', node_id: node, reason: (e as Error).message });
      this.setState('failed', (e as Error).message);
      return false;
    }
  }

  private targetLanguage(): string {
    return this.plan.race?.targetLanguage ?? 'zh-Hans';
  }

  private attachSinks(): void {
    for (const s of this.hub.streams) {
      if (s.type === 'overlay') {
        s.attach(overlaySink(this.clients.agentService('overlay'), { run_id: this.id, stream_id: s.streamId, range: this.plan.range, target_language: this.targetLanguage() }));
      } else if (s.type === 'screenshot_card') {
        s.attach(cardSink(this.clients.agentService('card'), {
          run_id: this.id,
          stream_id: s.streamId,
          image: this.start.image,
          target_language: this.targetLanguage(),
          anchor: this.start.anchor,
        }));
      }
    }
    if (this.hub.byType('web_display').length) void this.watchSharing();
  }

  private isOver(): boolean {
    return this.state === 'stopped' || this.state === 'completed' || this.state === 'failed';
  }

  /** Spec 05 requirement section 4.3: only send to the viewer while sharing is on. */
  private async watchSharing(): Promise<void> {
    try {
      for await (const m of this.clients.agent.serverStream<unknown, { enabled: boolean }>('agent', 'WatchSharing', {}, { deadlineMs: 0 })) {
        if (this.isOver()) return;
        this.sharing = m.enabled;
        for (const s of this.hub.byType('web_display')) {
          if (m.enabled && !s.attached) await this.publish(s);
          else if (!m.enabled && s.attached) s.detach();
        }
      }
    } catch {
      // agent gone; the run ends separately
    }
  }

  /** Publish a web display to the viewer. */
  private async publish(s: DisplayStream): Promise<void> {
    const wanted = () => this.sharing && !this.isOver() && !s.attached;
    if (!wanted()) return;
    this.viewer ??= await this.clients.acquire('viewer').catch(() => null);
    const peer = this.viewer && (await this.clients.peer(this.viewer).catch(() => null));
    if (!peer) {
      this.viewer = null; // not running, or gone since it was acquired
      return;
    }
    if (!wanted()) return;
    const start = { run_id: this.id, stream_id: s.streamId, device_id: this.start.device_id, range_label: this.start.range_label ?? 'screen', target_language: this.targetLanguage() };
    const sink = viewerSink(peer, start, () => {
      // ended by sharing off or the run ending, or already replaced: nothing to do
      if (!this.sharing || this.isOver() || (s.attached && !s.has(sink))) return;
      s.detach();
      void this.republish(s);
    });
    s.attach(sink);
  }

  /** The viewer went away (a crash; it is restarted on its own): publish again, same stream id, once it is back. */
  private async republish(s: DisplayStream): Promise<void> {
    this.viewer = null;
    for (let i = 0; i < 30 && this.sharing && !this.isOver() && !s.attached; i++) {
      await sleep(1_000);
      await this.publish(s); // does nothing once sharing is off or the run is over
    }
  }

  // ---------------- execution ----------------

  async execute(): Promise<void> {
    this.setState('running');
    this.hub.emit({ kind: 'run_state', state: 'running' });
    try {
      if (this.plan.entry === 'screenshot') {
        if (!this.start.image) throw new Error('screenshot run needs an image');
        await this.processBatch({ frame_id: 1, frame: this.start.image });
        await this.hub.flush();
        if (this.state === 'running') {
          this.setState('completed');
          void this.saveScreenshotHistory();
        }
      } else {
        await this.runContinuous();
      }
    } catch (e) {
      this.details.push({ kind: 'run_error', reason: (e as Error).message });
      if (this.state === 'running' || this.state === 'paused') await this.stop(`error: ${(e as Error).message}`);
    } finally {
      await this.hub.flush();
      this.hub.closeAll();
      this.clients.release();
    }
  }

  /** Requirement 09 section 2: a finished screenshot translation goes to this computer's history. */
  private async saveScreenshotHistory(): Promise<void> {
    const snap = this.displaySnapshot();
    if (!snap || !this.start.image) return;
    const paragraphs = snap.paragraphs.map(({ paragraph: p, shown }) => ({
      source: p.text,
      translation: shown?.show === 'text' ? shown.text : undefined,
      failed: shown?.show === 'error' ? shown.error_reason : undefined,
      bounds: p.bounds,
    }));
    if (!paragraphs.length) return;
    await this.clients.agent
      .unary('agent', 'SaveHistory', { entry: { kind: 'screenshot', run_id: this.id, target_language: this.targetLanguage(), image: this.start.image, paragraphs } }, { deadlineMs: 10_000 })
      .catch(() => undefined);
  }

  /** Spec 04 section 3.1. */
  private async runContinuous(): Promise<void> {
    const peer = await this.clients.peer(await this.clients.acquire('capture'));
    this.capture = new CaptureClient(peer);
    this.capture.onInterrupted = (reason) => {
      this.details.push({ kind: 'capture_interrupted', reason });
      if (reason === 'TARGET_CLOSED' || reason === 'DISPLAY_REMOVED') void this.stop(reason === 'TARGET_CLOSED' ? 'target window closed' : 'display removed');
      else void this.pause(`capture interrupted: ${reason}`);
    };
    await this.capture.start({
      range: this.plan.range ?? {},
      trigger: { interval_ms: this.plan.params.intervalMs },
      tolerance: this.plan.params.tolerance,
      tile: this.plan.params.tile,
      frame_format: 'raw_bgra8',
    });
    while (this.state === 'running' || this.state === 'paused') {
      if (this.state === 'paused') {
        await new Promise<void>((r) => this.resumeWaiters.push(r));
        continue;
      }
      let b: CaptureBatch | null;
      try {
        b = await this.capture.takeBatch(1000);
      } catch (e) {
        if (this.state === 'running') await this.stop(`capture failed: ${(e as Error).message}`);
        break;
      }
      if (!b || this.state !== 'running') continue;
      await this.processBatch(b);
    }
  }

  // ---------------- one batch (spec 04 section 3.2) ----------------

  private async processBatch(b: CaptureBatch): Promise<void> {
    if (this.last) for (const r of this.last.races.values()) r.restoreIfReopened();
    const seq = ++this.batchSeq;
    const p = this.plan.params;
    const W = b.frame.image.width;
    const H = b.frame.image.height;
    const reuse = planReuse(this.prev, b.change_map, W, H, { fullReocrRatio: p.fullReocrRatio, adjacencyPx: p.adjacencyPx, ocrMarginPx: p.ocrMarginPx }, this.ocrDone);
    let resolveAll!: () => void;
    const ctx: BatchCtx = {
      seq,
      deadline: performance.now() + p.batchDeadlineMs,
      W,
      H,
      units: [],
      races: new Map(),
      dispatchers: new Map(),
      pending: new Set(),
      allDone: () => resolveAll(),
      done: new Promise<void>((r) => (resolveAll = r)),
      abort: new AbortController(),
      ended: false,
    };
    this.current = ctx;

    // reused paragraphs get ids 1..R before batch_start
    const reused = reuse.reused.map((r, i) => ({ ...r, moved: { ...r.moved, paragraph_id: i + 1 } }));
    const imageId = `${this.id}:${seq}`;
    this.hub.batchStart(
      {
        kind: 'batch_start',
        batch_seq: seq,
        carried: reused.map((r) => ({ paragraph_id: r.moved.paragraph_id, from_paragraph_id: r.prev.unit.paragraph_id, dx: r.dx / W, dy: r.dy / H })),
        held: reuse.held.map((h) => h.unit.paragraph_id),
      },
      { ref: { image_id: imageId, width: W, height: H }, image: b.frame },
      b.frame.geometry as CaptureGeometry | undefined,
    );
    this.details.push({ kind: 'batch_start', batch_seq: seq, reason: `${reuse.full ? 'full' : 'partial'} ocr, ${reused.length} reused, ${reuse.held.length} held, ${reuse.regions.length} regions` });

    // OCR and normalization
    this.ocrDone = true;
    let all: Unit[] = reused.map((r) => r.moved);
    if (reuse.regions.length > 0) {
      try {
        const remaining = () => Math.max(1, ctx.deadline - performance.now());
        const ocr = await this.ocrPeer.unary<unknown, OcrResult>(
          'ocr',
          'Recognize',
          {
            run_id: this.id,
            batch_seq: seq,
            languages: this.plan.ocr.languages,
            regions: reuse.regions.map((r) => ({ image: cropBGRA(b.frame, r), rect: r, scale: 1 })),
          },
          { deadlineMs: Math.min(this.plan.ocr.timeoutMs, remaining()), signal: ctx.abort.signal },
        );
        if (ctx.abort.signal.aborted) throw new Error('aborted');
        const cleaned = dropDuplicates(ocr, reused.map((r) => r.moved.bounds!).filter(Boolean));
        const res = await this.normPeer.unary<unknown, { units: Unit[] }>(
          'normalize',
          'Normalize',
          { ocr: cleaned, reused: reused.map((r) => r.moved), first_id: reused.length + 1, frame_width: W, frame_height: H },
          { deadlineMs: remaining(), signal: ctx.abort.signal },
        );
        all = res.units;
      } catch (e) {
        this.ocrDone = false;
        if (!ctx.abort.signal.aborted) this.details.push({ kind: 'ocr_failed', batch_seq: seq, node_id: this.plan.ocr.node, reason: (e as Error).message });
      }
    }
    if (ctx.abort.signal.aborted) {
      this.ocrDone = false;
      return;
    }
    ctx.units = all;
    const fresh = all.filter((u) => u.origin !== 'reused');

    // spec 04 section 3.4: language of each new paragraph
    const race = this.plan.race;
    if (race && race.sourceLanguage === 'auto') {
      for (const u of fresh) if (!u.language) u.language = detectLanguage(u.text);
    }

    // paragraph_add with takeovers, then release unmatched held paragraphs (spec 04 section 4.6)
    const takeover = race ? matchHeld(reuse.held, fresh, (t) => this.cache.has(t)) : new Map<number, number>();
    for (const u of fresh) this.emitAdd(u, W, H, takeover.get(u.paragraph_id));
    const taken = new Set(takeover.values());
    const released = reuse.held.map((h) => h.unit.paragraph_id).filter((id) => !taken.has(id));
    if (released.length) this.hub.emit({ kind: 'held_release', paragraph_ids: released });

    // races, cache hits and same-language paragraphs
    const toRace: Unit[] = [];
    const statuses = new Map<number, boolean>();
    for (const r of reused) statuses.set(r.moved.paragraph_id, true);
    for (const u of fresh) {
      if (!race) {
        statuses.set(u.paragraph_id, true);
        continue;
      }
      if (!hasWords(u.text)) {
        this.endWithout(u.paragraph_id, 'no_words');
        statuses.set(u.paragraph_id, true);
        continue;
      }
      if (sameLanguage(u.language, race.targetLanguage)) {
        this.endWithout(u.paragraph_id, 'same_language');
        statuses.set(u.paragraph_id, true);
        continue;
      }
      const hit = this.cache.get(u.text);
      if (hit !== undefined) {
        this.hub.emit({ kind: 'paragraph_show', paragraph_id: u.paragraph_id, show: 'text', text: hit, source_rank: 1, version: 1, final: true });
        this.endWithout(u.paragraph_id, 'cache');
        statuses.set(u.paragraph_id, true);
        continue;
      }
      const r = new Race(race.node, seq, u.paragraph_id, race.sources.map((s) => ({ node: s.node, rank: s.rank })), this);
      ctx.races.set(u.paragraph_id, r);
      ctx.pending.add(u.paragraph_id);
      toRace.push(u);
    }
    if (race && toRace.length) {
      for (const s of race.sources) {
        const d = new SourceDispatcher({
          runId: this.id,
          batchSeq: seq,
          deadline: ctx.deadline,
          race,
          source: s,
          peer: this.sourcePeers.get(s.node)!,
          queue: this.shared.queueFor(s.service),
          availability: this.shared.availability,
          details: this.details,
          glossary: this.plan.glossary,
          contextBefore: (pid, n) => this.contextBefore(ctx, pid, n),
        });
        ctx.dispatchers.set(s.node, d);
      }
      for (const d of ctx.dispatchers.values()) d.start(toRace, ctx.races);
    }

    // wait for every race, or the batch deadline (spec 04 section 6.5)
    if (ctx.pending.size > 0) {
      const left = Math.max(0, ctx.deadline - performance.now());
      const timer = sleep(left, 'deadline' as const, { signal: ctx.abort.signal }).catch(() => 'aborted' as const);
      const which = await Promise.race([ctx.done.then(() => 'done' as const), timer]);
      if (which === 'deadline') for (const r of ctx.races.values()) r.onDeadline();
    }
    if (ctx.abort.signal.aborted) return;
    ctx.ended = true;
    for (const d of ctx.dispatchers.values()) d.cancelAll('batch ended');
    const endedBy = [...ctx.races.values()].some((r) => r.endedBy === 'deadline') ? 'deadline' : 'settled';
    this.hub.emit({ kind: 'batch_end', batch_seq: seq, ended_by: endedBy });
    for (const [pid, r] of ctx.races) statuses.set(pid, r.endState === 'complete');
    this.prev = { batchSeq: seq, width: W, height: H, paragraphs: all.map((u) => ({ unit: u, complete: statuses.get(u.paragraph_id) ?? false })) };
    this.last = ctx;
    this.current = null;
  }

  private emitAdd(u: Unit, W: number, H: number, takesOver?: number): void {
    const quads = (u.lines ?? []).map((l) => toRelativeQuad(l.quad, W, H));
    this.hub.emit({
      kind: 'paragraph_add',
      paragraph_id: u.paragraph_id,
      text: u.text,
      language: u.language,
      direction: u.direction ?? 'ltr',
      quads,
      bounds: toRelativeRect(u.bounds ?? { x: 0, y: 0, w: 0, h: 0 }, W, H),
      takes_over: takesOver,
    });
  }

  private endWithout(pid: number, via: Via): void {
    this.hub.emit({ kind: 'paragraph_end', paragraph_id: pid, end_state: 'complete', via });
    this.details.push({ kind: via === 'cache' ? 'cache_hit' : via, batch_seq: this.batchSeq, paragraph_id: pid });
  }

  private contextBefore(ctx: BatchCtx, pid: number, n: number): string[] {
    const ordered = [...ctx.units].sort((a, b) => a.order - b.order);
    const i = ordered.findIndex((u) => u.paragraph_id === pid);
    return ordered.slice(Math.max(0, i - n), Math.max(0, i)).map((u) => u.text);
  }

  // ---------------- RaceSink ----------------

  show(r: Race, body: ShowBody): void {
    if (!this.isLive(r)) return;
    this.hub.emit({ kind: 'paragraph_show', paragraph_id: r.paragraphId, ...body });
  }

  end(r: Race, state: EndState, via: Via): void {
    if (!this.isLive(r)) return;
    this.hub.emit({ kind: 'paragraph_end', paragraph_id: r.paragraphId, end_state: state, via });
    if (state === 'complete' && via === 'race' && r.shownText !== undefined) {
      const u = (this.current ?? this.last)?.units.find((x) => x.paragraph_id === r.paragraphId);
      if (u) this.cache.put(u.text, r.shownText);
    }
    // which source's text stayed and how each source ended; never the texts (spec 02 section 9.3)
    const rec = r.record();
    const shown = rec.shown_candidate ? `; shown rank ${rec.shown_candidate.rank} (${rec.shown_candidate.source})` : '';
    const sources = Object.entries(rec.sources).map(([k, v]) => `${k}=${v.state}`).join(', ');
    this.details.push({ kind: 'race_end', batch_seq: r.batchSeq, paragraph_id: r.paragraphId, node_id: r.raceNode, reason: `${state} by ${r.endedBy}${shown}; ${sources}` });
    const ctx = this.ctxOf(r);
    if (ctx) {
      ctx.pending.delete(r.paragraphId);
      if (ctx.pending.size === 0) ctx.allDone();
      if (ctx.ended && this.prev?.batchSeq === ctx.seq) {
        const p = this.prev.paragraphs.find((x) => x.unit.paragraph_id === r.paragraphId);
        if (p) p.complete = state === 'complete';
      }
    }
  }

  release(r: Race, sourceNode: string): void {
    this.ctxOf(r)?.dispatchers.get(sourceNode)?.release(r.paragraphId);
  }

  preferredUnavailable(r: Race, reason: string): void {
    const id = `${r.raceNode}:preferred`;
    if (this.noticeActive.has(id)) return;
    this.noticeActive.add(id);
    this.hub.emit({ kind: 'notice', notice_id: id, notice: 'preferred_unavailable', race_node: r.raceNode, reason, active: true });
  }

  private onAvailability(svc: string, available: boolean, reason: string): void {
    const race = this.plan.race;
    if (!race || !available) return;
    const pref = race.sources[0];
    if (!pref || pref.service.name !== svc) return;
    const id = `${race.node}:preferred`;
    if (!this.noticeActive.delete(id)) return;
    this.hub.emit({ kind: 'notice', notice_id: id, notice: 'preferred_unavailable', race_node: race.node, reason, active: false });
    // spec 04 section 6.3: tell the user they can retry the preferred source
    this.hooks.notify('preferred_recovered', `${pref.service.manifest.display_name} is available again; retry it to replace the provisional translations.`);
  }

  private ctxOf(r: Race): BatchCtx | null {
    if (this.current?.seq === r.batchSeq) return this.current;
    if (this.last?.seq === r.batchSeq) return this.last;
    return null;
  }

  private isLive(r: Race): boolean {
    const ctx = this.ctxOf(r);
    return !!ctx && !ctx.abort.signal.aborted && (this.batchSeq === r.batchSeq);
  }

  // ---------------- pause, resume, stop (spec 04 section 8) ----------------

  private closeLifecycles(by: 'pause' | 'stop'): void {
    const ctx = this.current;
    if (ctx) {
      for (const r of ctx.races.values()) if (!r.ended || r.reopenedBy) r.finish(by);
      for (const d of ctx.dispatchers.values()) d.cancelAll(by);
      if (!ctx.ended) this.ocrDone = this.ocrDone && ctx.units.length > 0;
      ctx.abort.abort(by);
      this.current = null;
    }
    if (this.last) {
      for (const r of this.last.races.values()) if (r.reopenedBy) r.finish(by);
      for (const d of this.last.dispatchers.values()) d.cancelAll(by);
    }
  }

  async pause(reason = 'user'): Promise<void> {
    if (this.state !== 'running' || this.plan.entry !== 'continuous') return;
    this.setState('paused', reason);
    await this.capture?.pause().catch(() => undefined);
    this.closeLifecycles('pause');
    this.hub.emit({ kind: 'run_state', state: 'paused', reason });
    this.details.push({ kind: 'paused', reason });
  }

  async resume(): Promise<void> {
    if (this.state !== 'paused') return;
    this.hub.emit({ kind: 'run_state', state: 'running' });
    await this.capture?.resume().catch(() => undefined);
    this.setState('running');
    for (const w of this.resumeWaiters.splice(0)) w();
  }

  async stop(reason = 'user'): Promise<void> {
    if (this.state === 'stopped' || this.state === 'completed' || this.state === 'failed') return;
    this.closeLifecycles('stop');
    this.capture?.close();
    this.cache?.clear();
    this.hub?.emit({ kind: 'run_state', state: 'stopped', reason });
    this.setState('stopped', reason);
    for (const w of this.resumeWaiters.splice(0)) w();
  }

  // ---------------- manual control (spec 04 section 9) ----------------

  async control(c: Control): Promise<void> {
    if ('pause' in c) return this.pause();
    if ('resume' in c) return this.resume();
    if ('stop' in c) return this.stop();
    const ctx = this.current ?? this.last;
    if (!ctx || !this.plan.race) return;
    if ('cancel' in c) {
      for (const r of ctx.races.values()) r.onCancelled(c.cancel.node_id);
      ctx.dispatchers.get(c.cancel.node_id)?.cancelAll('cancelled by user');
      this.details.push({ kind: 'cancel', node_id: c.cancel.node_id });
      return;
    }
    const node = c.retry.node_id;
    const source = this.plan.race.sources.find((s) => s.node === node);
    if (!source) return;
    const units = ctx.units.filter((u) => ctx.races.get(u.paragraph_id)?.retryEligible(node));
    if (units.length === 0) return;
    this.details.push({ kind: 'retry', node_id: node, batch_seq: ctx.seq, reason: `${units.length} paragraphs` });
    for (const u of units) {
      ctx.races.get(u.paragraph_id)!.reopen(node);
      ctx.pending.add(u.paragraph_id);
    }
    const d = new SourceDispatcher({
      runId: this.id,
      batchSeq: ctx.seq,
      deadline: undefined, // manual retries obey only the node timeout (spec 04 section 7.4)
      race: this.plan.race,
      source,
      peer: this.sourcePeers.get(node)!,
      queue: this.shared.queueFor(source.service),
      availability: this.shared.availability,
      details: this.details,
      glossary: this.plan.glossary,
      contextBefore: (pid, n) => this.contextBefore(ctx, pid, n),
    });
    ctx.dispatchers.set(node, d);
    d.start(units, ctx.races);
  }
}
