// Starts local service processes on demand and restarts them with backoff
// (spec 12 section 1.2). The boot line goes over stdin (spec 11 section 5).
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';

export interface ServiceSpec {
  /** Registered name, e.g. ocr.rapidocr. */
  name: string;
  command: string;
  args: string[];
  cwd: string;
  config?: Record<string, unknown>;
  env?: Record<string, string>;
}

interface Proc {
  spec: ServiceSpec;
  child: ChildProcess | null;
  crashes: number[];
  stopped: boolean;
  log?: WriteStream;
}

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000];

export class Supervisor {
  private readonly specs = new Map<string, ServiceSpec>();
  private readonly procs = new Map<string, Proc>();
  private readonly agentUrl: () => string;
  private readonly token: string;
  private readonly logDir: string;
  onExit?: (name: string, code: number | null) => void;

  constructor(opts: { agentUrl: () => string; token: string; logDir: string }) {
    this.agentUrl = opts.agentUrl;
    this.token = opts.token;
    this.logDir = opts.logDir;
    mkdirSync(this.logDir, { recursive: true });
  }

  define(spec: ServiceSpec): void {
    this.specs.set(spec.name, spec);
  }

  defined(): ServiceSpec[] {
    return [...this.specs.values()];
  }

  has(name: string): boolean {
    return this.specs.has(name);
  }

  isRunning(name: string): boolean {
    const p = this.procs.get(name);
    return !!p?.child && p.child.exitCode === null;
  }

  /** Start the service if it is not running. Registration completes asynchronously. */
  ensure(name: string): void {
    const spec = this.specs.get(name);
    if (!spec) throw new Error(`no service defined: ${name}`);
    let p = this.procs.get(name);
    if (!p) {
      p = { spec, child: null, crashes: [], stopped: false };
      this.procs.set(name, p);
    }
    if (p.child) return;
    p.stopped = false;
    this.launch(p);
  }

  private launch(p: Proc): void {
    const { spec } = p;
    p.log ??= createWriteStream(join(this.logDir, `${spec.name}.log`), { flags: 'a' });
    let child: ChildProcess;
    try {
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: { ...process.env, PYTHONUTF8: '1', ...spec.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      p.log.write(`spawn error: ${(e as Error).message}\n`);
      setImmediate(() => this.exited(p, null));
      return;
    }
    p.child = child;
    // a process that never started (missing command or working directory) reports an
    // error and no exit; either way the end is handled once (spec 12 section 1.2)
    let ended = false;
    const end = (code: number | null) => {
      if (ended) return;
      ended = true;
      if (p.child === child) p.child = null;
      this.exited(p, code);
    };
    child.stdout?.pipe(p.log, { end: false });
    child.stderr?.pipe(p.log, { end: false });
    child.stdin?.on('error', () => {}); // the process is gone; the error or exit event reports it
    child.stdin?.write(`${JSON.stringify({ agent: this.agentUrl(), token: this.token, name: spec.name, config: spec.config ?? {} })}\n`);
    child.on('error', (e) => {
      p.log?.write(`spawn error: ${e.message}\n`);
      if (child.pid === undefined) end(null);
    });
    child.on('exit', (code) => end(code));
  }

  private exited(p: Proc, code: number | null): void {
    this.onExit?.(p.spec.name, code);
    if (p.stopped) return;
    // restart with backoff; give up after 5 crashes within 30 s of start (spec 12 section 1.2)
    const now = Date.now();
    p.crashes = [...p.crashes.filter((t) => now - t < 5 * 60_000), now];
    if (p.crashes.length >= 5 && now - p.crashes[p.crashes.length - 5] < 5 * 30_000) {
      p.log?.write(`giving up after repeated crashes\n`);
      return;
    }
    const wait = BACKOFF_MS[Math.min(p.crashes.length - 1, BACKOFF_MS.length - 1)];
    setTimeout(() => {
      if (!p.stopped && !p.child) this.launch(p);
    }, wait).unref();
  }

  stop(name: string): void {
    const p = this.procs.get(name);
    if (!p) return;
    p.stopped = true;
    if (p.child) {
      p.child.stdin?.end();
      const c = p.child;
      setTimeout(() => {
        if (c.exitCode === null) c.kill();
      }, 3_000).unref();
    }
  }

  stopAll(): void {
    for (const name of this.procs.keys()) this.stop(name);
  }
}
