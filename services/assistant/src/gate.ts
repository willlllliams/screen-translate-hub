// Gates (spec 17 section 4): decide cheaply and locally when to wake the AI.
import type { Gate, GateDecision, GateInput } from './types.ts';

export interface RuleParams {
  /** Shortest time between two wakes. */
  minIntervalMs: number;
  /** Wakes per hour before the gate stops waking (unattended cost cap). */
  maxWakesPerHour: number;
  /** Changed area that counts as "the screen changed". */
  changeThreshold: number;
  /** How long the picture must stay still before it counts as settled. */
  stableMs: number;
}

/** First-version defaults (spec 17 section 4.2 leaves them open). */
export const DEFAULT_RULES: RuleParams = {
  minIntervalMs: 20_000,
  maxWakesPerHour: 30,
  changeThreshold: 0.2,
  stableMs: 1_500,
};

/** Rules 1 and 2: paused, too soon, hourly cap. Shared by the rule and composite gates. */
export function hardLimits(input: GateInput, p: RuleParams): GateDecision | null {
  if (input.paused) return { wake: false, confidence: 1, reason: 'paused' };
  if (input.last_wake_at) {
    const since = Date.parse(input.sample.at) - Date.parse(input.last_wake_at);
    if (since < p.minIntervalMs) return { wake: false, confidence: 1, reason: `last wake ${Math.round(since / 1000)} s ago` };
  }
  if (input.wakes_last_hour >= p.maxWakesPerHour) return { wake: false, confidence: 1, reason: `limit of ${p.maxWakesPerHour} wakes per hour reached` };
  return null;
}

export class RuleGate implements Gate {
  readonly name = 'rules';
  readonly params: RuleParams;

  constructor(params: Partial<RuleParams> = {}) {
    this.params = { ...DEFAULT_RULES, ...params };
  }

  async decide(input: GateInput, _signal?: AbortSignal): Promise<GateDecision> {
    return { ...(hardLimits(input, this.params) ?? this.content(input)), by: this.name };
  }

  /** Rules 3 to 5. */
  content(input: GateInput): GateDecision {
    const s = input.sample;
    const settled = s.changed_since_ms >= this.params.stableMs;
    if (s.app_switched && settled) return { wake: true, confidence: 0.8, reason: `switched to ${s.active_app || 'another app'}` };
    if (s.changed_ratio >= this.params.changeThreshold && settled) {
      return { wake: true, confidence: 0.7, reason: `${Math.round(s.changed_ratio * 100)}% of the screen changed` };
    }
    if (s.changed_ratio >= this.params.changeThreshold) return { wake: false, confidence: 0.6, reason: 'screen still changing' };
    return { wake: false, confidence: 0.9, reason: 'nothing new' };
  }
}

/** What the gate asks jev: a yes/no question and a choice whose confidence says how sure jev is. */
export interface JevAnswers {
  wake: { noul: number };
  change: { choice: string; confidence: number };
}

export type JevAsk = (state: string, signal: AbortSignal, timeoutMs: number) => Promise<JevAnswers>;

export interface JevOptions {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  timeoutMs?: number;
  /** Minimum confidence for jev's answer to count. */
  minConfidence?: number;
  /** Probability above which to wake. */
  wakeProbability?: number;
  /** Replaces the SDK call (tests). */
  ask?: JevAsk;
}

/** The real call through @typesafe-ai/sdk: one systemOne request, no retries (the gate has a time budget). */
export function jevAsk(o: { apiKey: string; baseURL?: string; model?: string }): JevAsk {
  let client: Promise<{ systemOne: (req: unknown, opts: unknown) => Promise<{ answers: JevAnswers }> }> | null = null;
  return async (state, signal, timeoutMs) => {
    const sdk = await import('@typesafe-ai/sdk');
    client ??= Promise.resolve(new sdk.TypeSafeClient({ apiKey: o.apiKey, baseURL: o.baseURL, logLevel: 'off', retry: { maxRetries: 0 } }) as never);
    const c = await client;
    const res = await c.systemOne(
      {
        state,
        model: o.model,
        questions: {
          wake: sdk.noul('Does the user need the assistant to look at the screen right now?'),
          change: sdk.choice('What happened on the screen since the assistant last looked?', {
            new_content: 'different content the user is now reading or working on',
            same_content: 'the same content, scrolled slightly or unchanged',
            transition: 'an animation, loading or a half-drawn screen',
            idle: 'nothing; the user is away or idle',
          }),
        },
      },
      { signal, timeout: timeoutMs },
    );
    return res.answers;
  };
}

/**
 * Model gate backed by jev (TypeSafe AI System One, spec 17 section 4.3): a text state,
 * a yes/no question for the wake probability and a choice question whose confidence
 * says whether to trust it. Falls back to the rule gate when jev is unconfigured, slow,
 * failing or unsure. It only decides; it never generates content.
 */
export class JevGate implements Gate {
  readonly name = 'jev';
  private readonly o: Required<Pick<JevOptions, 'timeoutMs' | 'minConfidence' | 'wakeProbability'>>;
  private readonly ask?: JevAsk;
  private readonly fallback: RuleGate;

  constructor(o: JevOptions, fallback = new RuleGate()) {
    this.o = { timeoutMs: o.timeoutMs ?? 800, minConfidence: o.minConfidence ?? 0.6, wakeProbability: o.wakeProbability ?? 0.5 };
    this.ask = o.ask ?? (o.apiKey ? jevAsk({ apiKey: o.apiKey, baseURL: o.baseURL, model: o.model }) : undefined);
    this.fallback = fallback;
  }

  static stateText(input: GateInput): string {
    const s = input.sample;
    return [
      `Task: ${input.task || '(none, just keeping the user company)'}`,
      `Active app: ${s.active_app || 'unknown'}; window: ${s.window_title || 'untitled'}`,
      `Switched app since last check: ${s.app_switched ? 'yes' : 'no'}`,
      `Screen changed since the assistant last looked: ${Math.round(s.changed_ratio * 100)}%; still for ${Math.round(s.changed_since_ms / 1000)} s`,
      `User idle for ${Math.round(s.user_idle_ms / 1000)} s`,
      s.ocr_excerpt ? `Visible text: ${s.ocr_excerpt}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  async decide(input: GateInput, signal: AbortSignal): Promise<GateDecision> {
    const hard = hardLimits(input, this.fallback.params);
    if (hard) return { ...hard, by: this.name };
    const viaRules = (why: string): GateDecision => {
      const d = this.fallback.content(input);
      return { ...d, reason: `${d.reason} (${why})`, by: 'rules' };
    };
    if (!this.ask) return viaRules('jev not configured');
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, this.o.timeoutMs);
    const onAbort = () => ctl.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const a = await this.ask(JevGate.stateText(input), ctl.signal, this.o.timeoutMs);
      const p = a.wake?.noul;
      const c = a.change?.confidence ?? 0;
      if (typeof p !== 'number' || c < this.o.minConfidence) return viaRules('jev unsure');
      return { wake: p >= this.o.wakeProbability, confidence: c, reason: `jev: ${a.change.choice}, p=${p.toFixed(2)}`, by: this.name };
    } catch {
      return viaRules(timedOut ? 'jev timed out' : 'jev unreachable');
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }
}

/** Hard limits first, then the model gate, which itself falls back to the rules (spec 17 section 4.4). */
export class CompositeGate implements Gate {
  readonly name = 'composite';
  private readonly model: JevGate;
  private readonly rules: RuleGate;

  constructor(model: JevGate, rules: RuleGate) {
    this.model = model;
    this.rules = rules;
  }

  async decide(input: GateInput, signal: AbortSignal): Promise<GateDecision> {
    const hard = hardLimits(input, this.rules.params);
    if (hard) return { ...hard, by: 'rules' };
    return this.model.decide(input, signal);
  }
}

export function makeGate(name: string | undefined, o: { jev?: JevOptions; rules?: Partial<RuleParams> }): Gate {
  const rules = new RuleGate(o.rules);
  if (name === 'jev') return new JevGate(o.jev ?? {}, rules);
  if (name === 'composite') return new CompositeGate(new JevGate(o.jev ?? {}, rules), rules);
  return rules;
}
