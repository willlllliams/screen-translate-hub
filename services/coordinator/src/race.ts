// Race for one paragraph on one race node (spec 04 section 6, requirement 03 section 5).
import type { EndState, EndedBy, RaceRecord, SourceOutcome, SourceState, Via } from '@sth/model';

export interface SourceRef {
  node: string;
  /** Rank 1 is the preferred source s*. */
  rank: number;
}

export type ShowBody =
  | { show: 'text'; text: string; source_rank: number; version: number; final: boolean }
  | { show: 'error'; error_reason: string };

export interface RaceSink {
  show(r: Race, body: ShowBody): void;
  end(r: Race, state: EndState, via: Via): void;
  /** Paragraph no longer needs this source's request (spec 04 section 6.4 release). */
  release(r: Race, sourceNode: string): void;
  /** Preferred source became wholly unavailable: raise the notice. */
  preferredUnavailable(r: Race, reason: string): void;
}

interface Shown {
  source: string;
  rank: number;
  version: number;
  final: boolean;
  text: string;
}

const RUNNING: ReadonlySet<SourceState> = new Set(['queued', 'running']);

export class Race {
  readonly raceNode: string;
  readonly batchSeq: number;
  readonly paragraphId: number;
  readonly sources: SourceRef[];
  readonly preferred: string;
  private readonly sink: RaceSink;
  private readonly outcomes = new Map<string, SourceOutcome>();
  private shown: Shown | 'none' | 'error' = 'none';
  private errorReason?: string;
  endState?: EndState;
  endedBy?: EndedBy;
  via: Via = 'race';
  /** Reopened by a manual retry of `retrySource` (spec 04 section 9). */
  reopenedBy?: string;
  private beforeReopen?: { endState?: EndState; endedBy?: EndedBy; shown: Shown | 'none' | 'error'; errorReason?: string };

  constructor(raceNode: string, batchSeq: number, paragraphId: number, sources: SourceRef[], sink: RaceSink) {
    this.raceNode = raceNode;
    this.batchSeq = batchSeq;
    this.paragraphId = paragraphId;
    this.sources = [...sources].sort((a, b) => a.rank - b.rank);
    this.preferred = this.sources[0]?.node ?? '';
    this.sink = sink;
    for (const s of this.sources) this.outcomes.set(s.node, { state: 'queued', has_output: false, last_version: 0 });
  }

  get ended(): boolean {
    return this.endState !== undefined;
  }

  get shownText(): string | undefined {
    return typeof this.shown === 'object' ? this.shown.text : undefined;
  }

  rankOf(node: string): number {
    return this.sources.find((s) => s.node === node)?.rank ?? Infinity;
  }

  outcome(node: string): SourceOutcome | undefined {
    return this.outcomes.get(node);
  }

  isRunning(node: string): boolean {
    const o = this.outcomes.get(node);
    return !!o && RUNNING.has(o.state);
  }

  markRunning(node: string): void {
    const o = this.outcomes.get(node);
    if (o && o.state === 'queued') o.state = 'running';
  }

  /** Spec 04 section 6.4. */
  canAffect(node: string): boolean {
    if (!this.isRunning(node)) return false;
    // an error is final, except for a manual retry of the preferred source (spec 04 section 9)
    if (this.shown === 'error') return this.reopenedBy === this.preferred && node === this.preferred;
    if (this.shown === 'none') return true;
    const r = this.rankOf(node);
    return r < this.shown.rank || (node === this.shown.source && !this.shown.final);
  }

  /** Spec 04 section 6.2. `text` undefined means a final signal without new text. */
  onCandidate(node: string, version: number, final: boolean, text: string | undefined): void {
    if (this.ended && !this.reopenedBy) return; // validity rule 5
    const o = this.outcomes.get(node);
    if (!o || !RUNNING.has(o.state)) return; // pruned or cancelled: request was released
    const resolvedText = text ?? (typeof this.shown === 'object' && this.shown.source === node ? this.shown.text : '');
    o.has_output = true;
    o.last_version = version;
    let replace: boolean;
    if (this.shown === 'error') {
      if (!(this.reopenedBy === this.preferred && node === this.preferred)) return;
      replace = true;
    } else {
      const r = this.rankOf(node);
      replace =
        this.shown === 'none' ||
        r < this.shown.rank ||
        (node === this.shown.source && version > this.shown.version);
    }
    if (replace) {
      this.shown = { source: node, rank: this.rankOf(node), version, final, text: resolvedText };
      this.sink.show(this, { show: 'text', text: resolvedText, source_rank: this.rankOf(node), version, final });
    }
    if (node === this.preferred && final) {
      o.state = 'finished';
      this.finish('settled');
      return;
    }
    if (final) o.state = 'finished';
    this.prune();
    if (!this.anyCanAffect()) this.finish('all_ended');
  }

  /** Spec 04 section 6.3. cause is the ended_by used when the preferred source fails per segment. */
  onFailure(node: string, cls: 'whole' | 'segment', reason: string, cause: EndedBy = 'settled'): void {
    if (this.ended && !this.reopenedBy) return;
    const o = this.outcomes.get(node);
    if (!o || !RUNNING.has(o.state)) return;
    o.reason = reason;
    if (node !== this.preferred) {
      o.state = cls === 'whole' ? 'unavailable' : 'failed';
      this.prune();
      if (!this.anyCanAffect()) this.finish('all_ended');
      return;
    }
    if (cls === 'whole') {
      o.state = 'unavailable';
      this.sink.preferredUnavailable(this, reason);
      this.prune();
      if (!this.anyCanAffect()) this.finish('all_ended');
      return;
    }
    o.state = 'failed';
    if (!o.has_output) {
      this.shown = 'error';
      this.errorReason = reason;
      this.sink.show(this, { show: 'error', error_reason: reason });
    }
    this.finish(cause);
  }

  /** User cancelled a source's call (spec 04 section 9). */
  onCancelled(node: string): void {
    const o = this.outcomes.get(node);
    if (!o || !RUNNING.has(o.state)) return;
    o.state = 'cancelled';
    this.sink.release(this, node);
    if (node === this.preferred) {
      this.finish('cancel');
      return;
    }
    this.prune();
    if (!this.anyCanAffect()) this.finish('all_ended');
  }

  /** Batch deadline (spec 04 section 6.5 on_deadline). */
  onDeadline(): void {
    if (this.ended || this.reopenedBy) return;
    if (this.isRunning(this.preferred)) this.onFailure(this.preferred, 'segment', 'batch deadline', 'deadline');
    else this.finish('deadline');
  }

  prune(): void {
    for (const s of this.sources) {
      const o = this.outcomes.get(s.node)!;
      if (RUNNING.has(o.state) && !this.canAffect(s.node)) {
        o.state = 'pruned';
        this.sink.release(this, s.node);
      }
    }
  }

  private anyCanAffect(): boolean {
    return this.sources.some((s) => this.canAffect(s.node));
  }

  finish(by: EndedBy): void {
    if (this.ended && !this.reopenedBy) return;
    if (this.reopenedBy) this.reopenedBy = undefined;
    for (const s of this.sources) {
      const o = this.outcomes.get(s.node)!;
      if (RUNNING.has(o.state)) {
        o.state = 'pruned';
        this.sink.release(this, s.node);
      }
    }
    this.endedBy = by;
    this.endState = this.computeEndState(by);
    this.sink.end(this, this.endState, this.via);
  }

  private computeEndState(by: EndedBy): EndState {
    const pref = this.outcomes.get(this.preferred);
    if (typeof this.shown === 'object' && this.shown.source === this.preferred && this.shown.final) return 'complete';
    if (typeof this.shown === 'object' && this.shown.source === this.preferred) return 'partial';
    if (this.shown === 'error') return 'error';
    if (pref?.state === 'unavailable') return 'provisional';
    if (by === 'pause' || by === 'stop' || by === 'cancel' || pref?.state === 'cancelled') return 'aborted';
    return 'error'; // unreachable (spec 04 section 6.6 property 1)
  }

  /** Spec 04 section 9: can a retry of `node` change this paragraph? */
  retryEligible(node: string): boolean {
    if (this.endState === 'complete') return false;
    const o = this.outcomes.get(node);
    if (!o || !['failed', 'unavailable', 'cancelled', 'pruned'].includes(o.state)) return false;
    if (node === this.preferred) return true;
    if (this.shown === 'error') return false;
    return this.shown === 'none' || this.shown.rank > this.rankOf(node);
  }

  reopen(node: string): void {
    this.beforeReopen = { endState: this.endState, endedBy: this.endedBy, shown: this.shown, errorReason: this.errorReason };
    this.reopenedBy = node;
    this.endState = undefined;
    this.endedBy = undefined;
    const o = this.outcomes.get(node)!;
    o.state = 'queued';
    o.reason = undefined;
    this.prune();
  }

  /** The next batch began before a reopened race ended: restore the previous result. */
  restoreIfReopened(): void {
    if (!this.reopenedBy || !this.beforeReopen) return;
    for (const s of this.sources) {
      const o = this.outcomes.get(s.node)!;
      if (RUNNING.has(o.state)) {
        o.state = 'cancelled';
        this.sink.release(this, s.node);
      }
    }
    this.reopenedBy = undefined;
    this.endState = this.beforeReopen.endState;
    this.endedBy = this.beforeReopen.endedBy;
    this.shown = this.beforeReopen.shown;
    this.errorReason = this.beforeReopen.errorReason;
  }

  record(): RaceRecord {
    const rec: RaceRecord = {
      race_node: this.raceNode,
      batch_seq: this.batchSeq,
      paragraph_id: this.paragraphId,
      shown: this.shown === 'none' ? 'none' : this.shown === 'error' ? 'error' : 'candidate',
      sources: Object.fromEntries([...this.outcomes.entries()].map(([k, v]) => [k, { ...v }])),
      via: this.via,
    };
    if (typeof this.shown === 'object') {
      rec.shown_candidate = { source: this.shown.source, rank: this.shown.rank, version: this.shown.version, final: this.shown.final };
      rec.shown_text = this.shown.text;
    }
    if (this.errorReason) rec.error_reason = this.errorReason;
    if (this.endState) rec.end_state = this.endState;
    if (this.endedBy) rec.ended_by = this.endedBy;
    return rec;
  }
}
