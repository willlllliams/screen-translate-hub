// Translation through the locally logged-in Claude Code CLI in headless mode
// (requirement 09 section 3.3). For development and the client's own use.
//
// Each request runs in its own `claude -p` process, so no conversation history
// builds up. To hide the CLI start-up time (about 2 s) one process per slot is
// started ahead of time and waits for its prompt on stdin.
import type { ServiceManifest } from '@sth/model';
import { RpcError } from '@sth/wire';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aiManifest, type Emit, type TranslateEngine, type TranslateRequest } from './engine.ts';
import { buildPrompt, DEFAULT_SYSTEM } from './prompt.ts';
import { ItemStreamer } from './streaming.ts';

export interface ClaudeCliConfig {
  /** Model alias or full id; default "haiku" (the cheapest). */
  model?: string;
  /** Path to the claude executable; default "claude" from PATH. */
  command?: string;
  /** Number of pre-started processes, which is also the concurrency limit. */
  warm?: number;
  /** Spend limit per call in USD, passed as --max-budget-usd. */
  max_budget_usd?: number;
}

interface Warm {
  proc: ChildProcess;
  stdout: string[];
  stderr: string[];
  exited: Promise<number | null>;
}

export class ClaudeCliEngine implements TranslateEngine {
  readonly id = 'claude-cli';
  private readonly cfg: ClaudeCliConfig;
  private readonly cwd: string;
  private pool: Warm[] = [];
  private closed = false;

  constructor(cfg: ClaudeCliConfig = {}) {
    this.cfg = cfg;
    // an empty working directory: no project instructions or settings get loaded. One fixed
    // directory shared by every instance, so nothing is left behind when the service is killed.
    this.cwd = join(tmpdir(), 'sth-claude');
    mkdirSync(this.cwd, { recursive: true });
    for (let i = 0; i < this.slots(); i++) this.pool.push(this.spawnWarm());
  }

  private slots(): number {
    return Math.max(1, this.cfg.warm ?? 2);
  }

  manifest(name: string): ServiceManifest {
    return aiManifest(name, `Claude Code (${this.cfg.model ?? 'haiku'})`, 'claude-cli', {
      max_concurrency: this.slots(),
      requests_per_second: 2,
      burst: this.slots(),
      max_units_per_request: 24,
      max_chars_per_request: 6000,
    });
  }

  private spawnWarm(): Warm {
    const args = [
      '-p',
      '--model', this.cfg.model ?? 'haiku',
      '--tools', '',
      '--no-session-persistence',
      '--strict-mcp-config',
      '--disable-slash-commands',
      // stream-json input waits for the prompt indefinitely; plain stdin gives up after 3 s
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--system-prompt', DEFAULT_SYSTEM,
    ];
    if (this.cfg.max_budget_usd) args.push('--max-budget-usd', String(this.cfg.max_budget_usd));
    const proc = spawn(this.cfg.command ?? 'claude', args, { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const warm: Warm = {
      proc,
      stdout: [],
      stderr: [],
      // a process that cannot start (claude not installed) emits only 'error', never 'exit'
      exited: new Promise((r) => {
        proc.once('exit', (code) => r(code));
        proc.once('error', () => r(null));
      }),
    };
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (d: string) => warm.stderr.push(d));
    proc.on('error', (e) => warm.stderr.push(String(e)));
    // writing the prompt to a process that never started fails with EPIPE/EOF
    proc.stdin?.on('error', () => {});
    return warm;
  }

  private take(): Warm {
    const w = this.pool.shift() ?? this.spawnWarm();
    if (!this.closed) this.pool.push(this.spawnWarm());
    return w;
  }

  async translate(req: TranslateRequest, emit: Emit, signal: AbortSignal): Promise<void> {
    const w = this.take();
    const { user } = buildPrompt(req);
    const streamer = new ItemStreamer(req, emit);
    const onAbort = () => w.proc.kill();
    signal.addEventListener('abort', onAbort, { once: true });
    let text = '';
    let resultText: string | null = null;
    let isError = false;
    let pending = '';
    let chain = Promise.resolve();
    w.proc.stdout?.setEncoding('utf8');
    w.proc.stdout?.on('data', (chunk: string) => {
      pending += chunk;
      let i: number;
      while ((i = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, i).trim();
        pending = pending.slice(i + 1);
        if (!line) continue;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === 'stream_event') {
          const e = ev.event as { type?: string; delta?: { type?: string; text?: string } };
          if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
            text += e.delta.text;
            const snapshot = text;
            chain = chain.then(() => streamer.progress(snapshot));
          }
        } else if (ev.type === 'result') {
          resultText = typeof ev.result === 'string' ? ev.result : null;
          isError = ev.is_error === true;
        }
      }
    });
    // one user message, then end the input so the process exits after this turn
    w.proc.stdin?.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content: user } })}\n`);
    const code = await w.exited;
    signal.removeEventListener('abort', onAbort);
    await chain;
    if (signal.aborted) throw new RpcError('cancelled');
    if (code !== 0 || isError || resultText === null) {
      const err = (w.stderr.join('') + (resultText ?? '')).slice(0, 300);
      if (/rate.?limit|429|overloaded/i.test(err)) throw new RpcError('rate_limited', err);
      if (/not logged in|login|auth/i.test(err)) throw new RpcError('permission_denied', err);
      if (code === null && /ENOENT/.test(err)) throw new RpcError('unavailable', `claude not found (${this.cfg.command ?? 'claude'})`);
      throw new RpcError('unavailable', `claude exited ${code}: ${err}`);
    }
    await streamer.complete(resultText);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const w of this.pool) w.proc.kill();
    this.pool = [];
  }
}
