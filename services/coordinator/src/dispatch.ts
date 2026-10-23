// Translation requests for one source in one batch (spec 04 section 7): group the
// paragraphs that need racing, queue per service, stream results into the races,
// classify failures, and cancel a request once no paragraph needs it.
import { sameLanguage, supports, type Unit } from '@sth/model';
import { failureClass, RpcError, type Peer, type Status } from '@sth/wire';
import type { Availability } from './availability.ts';
import type { RunDetails } from './details.ts';
import { dominantScript } from './langid.ts';
import type { ServiceQueue } from './queue.ts';
import type { Race } from './race.ts';
import type { RacePlan, SourcePlan } from './types.ts';

interface Update { paragraph_id: number; text?: string; final: boolean }
type Reply = { update?: Update; failed?: { paragraph_id: number; status: Status } };

export interface DispatchDeps {
  runId: string;
  batchSeq: number;
  /** performance.now() based; undefined for manual retries (node timeout only). */
  deadline?: number;
  race: RacePlan;
  source: SourcePlan;
  peer: Peer;
  queue: ServiceQueue;
  availability: Availability;
  details: RunDetails;
  glossary: Array<{ source: string; target: string; note?: string }>;
  /** Earlier paragraphs in reading order, for the context option. */
  contextBefore: (paragraphId: number, count: number) => string[];
}

class Request {
  readonly pids: number[];
  readonly remaining: Set<number>;
  readonly settled = new Set<number>();
  readonly versions = new Map<number, number>();
  readonly abort = new AbortController();
  cancel?: (reason: string) => void;

  constructor(pids: number[]) {
    this.pids = pids;
    this.remaining = new Set(pids);
  }
}

export class SourceDispatcher {
  private readonly d: DispatchDeps;
  private readonly races = new Map<number, Race>();
  private readonly requests: Request[] = [];
  private readonly byParagraph = new Map<number, Request>();

  constructor(deps: DispatchDeps) {
    this.d = deps;
  }

  get node(): string {
    return this.d.source.node;
  }

  /** Language to send for a unit, or a reason why this source cannot take it (spec 04 section 3.4). */
  private languageFor(u: Unit): { lang?: string; error?: string } {
    const m = this.d.source.service.manifest.languages;
    const declared = m?.source ?? [];
    let lang = this.d.race.sourceLanguage !== 'auto' ? this.d.race.sourceLanguage : u.language;
    if (!lang && !m?.detects_source) {
      // v1: unlabelled Latin text is most often English
      if (dominantScript(u.text) === 'latin') lang = 'en';
      else return { error: 'cannot determine the source language' };
    }
    if (lang && declared.length > 0 && !supports(declared, lang) && !m?.detects_source) {
      return { error: `language not supported: ${lang}` };
    }
    if (lang && sameLanguage(lang, this.d.race.targetLanguage) && !m?.detects_source) {
      return { error: `source and target are both ${lang}` };
    }
    return { lang };
  }

  start(units: Unit[], races: Map<number, Race>): void {
    const s = this.d.source;
    const groups: Unit[][] = [];
    let cur: Unit[] = [];
    let chars = 0;
    for (const u of units) {
      const race = races.get(u.paragraph_id);
      if (!race) continue;
      this.races.set(u.paragraph_id, race);
      const { error } = this.languageFor(u);
      if (error) {
        race.onFailure(s.node, 'segment', error);
        continue;
      }
      if (cur.length > 0 && (cur.length >= s.maxUnits || chars + u.text.length > s.maxChars)) {
        groups.push(cur);
        cur = [];
        chars = 0;
      }
      cur.push(u);
      chars += u.text.length;
    }
    if (cur.length) groups.push(cur);
    for (const g of groups) void this.run(g);
  }

  /** The race of `pid` no longer needs this source (pruned or finished). */
  release(pid: number): void {
    const req = this.byParagraph.get(pid);
    if (!req) return;
    req.remaining.delete(pid);
    if (req.remaining.size === 0) {
      req.abort.abort(new RpcError('cancelled', 'released'));
      req.cancel?.('released');
    }
  }

  cancelAll(reason: string): void {
    for (const r of this.requests) {
      r.abort.abort(new RpcError('cancelled', reason));
      r.cancel?.(reason);
    }
  }

  private async run(units: Unit[]): Promise<void> {
    const s = this.d.source;
    const svc = s.service.name;
    const req = new Request(units.map((u) => u.paragraph_id));
    this.requests.push(req);
    for (const pid of req.pids) this.byParagraph.set(pid, req);

    const down = this.d.availability.check(svc);
    if (down) {
      for (const pid of req.pids) this.races.get(pid)?.onFailure(s.node, 'whole', `${svc} unavailable: ${down.reason}`);
      return;
    }
    let release: (() => void) | undefined;
    try {
      release = await this.d.queue.acquire(req.abort.signal);
    } catch {
      return; // released or cancelled while queued
    }
    try {
      if (req.remaining.size === 0) return;
      // spec 04 section 7.4: node timeout from send, capped by the batch deadline
      let deadlineMs = s.timeoutMs;
      if (this.d.deadline !== undefined) deadlineMs = Math.min(deadlineMs, Math.max(1, this.d.deadline - performance.now()));
      const live = units.filter((u) => req.remaining.has(u.paragraph_id));
      for (const u of live) this.races.get(u.paragraph_id)?.markRunning(s.node);
      const stream = this.d.peer.open<Reply, unknown>('translate', 'Translate', {
        deadlineMs,
        meta: { run_id: this.d.runId, batch_seq: String(this.d.batchSeq), node: s.node },
      });
      req.cancel = (reason) => stream.cancel(reason);
      if (req.abort.signal.aborted) stream.cancel('released');
      const ctx = s.contextCount > 0 && live.length ? this.d.contextBefore(live[0].paragraph_id, s.contextCount) : undefined;
      try {
        await stream.send({
          segments: live.map((u) => ({ paragraph_id: u.paragraph_id, text: u.text, language: this.languageFor(u).lang })),
          source_language: this.d.race.sourceLanguage,
          target_language: this.d.race.targetLanguage,
          glossary: s.useGlossary ? this.d.glossary : [],
          context: ctx,
          mode: s.mode,
          prompt_template: s.promptTemplate,
        });
        stream.halfClose();
        for await (const r of stream) this.onReply(req, r);
      } catch {
        // the final status below decides how unfinished paragraphs fail
      }
      const status = await stream.done;
      this.onEnd(req, status);
    } finally {
      release?.();
    }
  }

  private onReply(req: Request, r: Reply): void {
    const s = this.d.source;
    if (r.update) {
      const pid = r.update.paragraph_id;
      if (!req.pids.includes(pid) || req.settled.has(pid)) return;
      const v = (req.versions.get(pid) ?? 0) + 1;
      req.versions.set(pid, v);
      if (r.update.final) req.settled.add(pid);
      this.races.get(pid)?.onCandidate(s.node, v, r.update.final, r.update.text);
    } else if (r.failed) {
      const pid = r.failed.paragraph_id;
      if (!req.pids.includes(pid) || req.settled.has(pid)) return;
      req.settled.add(pid);
      const cls = failureClass(r.failed.status.code) ?? 'segment';
      this.d.details.push({ kind: 'paragraph_failed', batch_seq: this.d.batchSeq, node_id: s.node, paragraph_id: pid, service: s.service.name, reason: r.failed.status.code });
      this.races.get(pid)?.onFailure(s.node, cls, r.failed.status.message ?? r.failed.status.code);
    }
  }

  private onEnd(req: Request, status: Status): void {
    const s = this.d.source;
    const unsettled = req.pids.filter((p) => !req.settled.has(p) && req.remaining.has(p));
    if (status.code === 'cancelled' && req.remaining.size === 0) return;
    if (unsettled.length === 0) return;
    let cls: 'whole' | 'segment' = 'segment';
    let reason = status.message ?? status.code;
    if (status.code === 'ok') {
      reason = 'stream ended without completion';
    } else {
      cls = failureClass(status.code) ?? 'segment';
      if (cls === 'whole') this.d.availability.mark(s.service.name, status.code, reason, status.retryAfterMs);
    }
    this.d.details.push({ kind: cls === 'whole' ? 'source_unavailable' : 'request_failed', batch_seq: this.d.batchSeq, node_id: s.node, service: s.service.name, reason: status.code });
    for (const pid of unsettled) this.races.get(pid)?.onFailure(s.node, cls, reason);
  }
}
