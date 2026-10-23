// Claude Code brain (spec 17 section 5.2): one headless `claude -p` process per session
// in stream-json mode, so the conversation carries over between wakes. Built-in tools
// are off; the platform tools come in through this service's MCP server (mcp.ts).
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { systemPrompt } from './tools.ts';
import type { Brain, BrainEvent, PlatformTool, WakeEvent } from './types.ts';

export interface ClaudeBrainConfig {
  model?: string;
  command?: string;
  /** Where the MCP proxy reaches this service. */
  assistantUrl: string;
  token: string;
  sessionId: string;
  node?: string;
}

const DIR_PREFIX = 'sth-assistant-';

/**
 * Removes the directories of sessions that ended without close(), because the service was
 * killed. They hold an MCP config with that service run's (now useless) session token.
 */
export function removeStaleDirs(): void {
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(DIR_PREFIX)) continue;
    try {
      rmSync(join(tmpdir(), name), { recursive: true, force: true });
    } catch {
      // still in use by a process that outlived its service: leave it
    }
  }
}

/** The text a wake sends as the user turn. */
export function wakeText(ev: WakeEvent): string {
  if (ev.kind === 'user_message') return ev.text ?? '';
  if (ev.kind === 'hotkey') return '[The user called you with the hotkey. Look at the screen and help with what they are doing.]';
  const s = ev.sample;
  const where = s ? ` The user is in ${s.active_app || 'an app'}${s.window_title ? ` ("${s.window_title}")` : ''}.` : '';
  return `[Heartbeat: ${ev.decision?.reason ?? 'the screen changed'}.${where} Look at the screen if useful. If there is nothing worth saying, reply with a single "-".]`;
}

/**
 * The system prompt is fixed when the model's conversation starts, so a task set later
 * reaches it as a note in front of the next wake's text.
 */
export function withTask(text: string, task: string | null): string {
  return task === null ? text : `[The user's task is now: ${task || '(none)'}]\n${text}`;
}

/** Async queue bridging the process's stdout to the wake iterator. */
class Lines {
  private items: Array<Record<string, unknown>> = [];
  private waiters: Array<() => void> = [];
  ended = false;

  push(m: Record<string, unknown>): void {
    this.items.push(m);
    for (const w of this.waiters.splice(0)) w();
  }

  end(): void {
    this.ended = true;
    for (const w of this.waiters.splice(0)) w();
  }

  async next(): Promise<Record<string, unknown> | null> {
    for (;;) {
      if (this.items.length) return this.items.shift()!;
      if (this.ended) return null;
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }
}

export class ClaudeCodeBrain implements Brain {
  readonly name = 'claude-code';
  private readonly cfg: ClaudeBrainConfig;
  private proc: ChildProcess | null = null;
  private lines = new Lines();
  private dir = '';
  private task = '';
  /** A task set since the process started, not yet told to the model. */
  private taskNote: string | null = null;
  private stderr = '';

  constructor(cfg: ClaudeBrainConfig) {
    this.cfg = cfg;
  }

  async open(task: string, _tools: PlatformTool[]): Promise<void> {
    this.task = task;
    this.dir = mkdtempSync(join(tmpdir(), DIR_PREFIX));
    this.start();
  }

  setTask(task: string): void {
    this.task = task;
    this.taskNote = task;
  }

  private start(): void {
    // a new process gets the current task in its system prompt
    this.taskNote = null;
    const mcpScript = join(dirname(fileURLToPath(import.meta.url)), 'mcp.ts');
    const mcpConfig = join(this.dir, 'mcp.json');
    // the session token goes into a file in a private temp directory rather than onto a command line
    writeFileSync(
      mcpConfig,
      JSON.stringify({
        mcpServers: {
          sth: {
            command: this.cfg.node ?? process.execPath,
            args: [mcpScript],
            env: { STH_ASSISTANT_URL: this.cfg.assistantUrl, STH_TOKEN: this.cfg.token, STH_SESSION: this.cfg.sessionId },
          },
        },
      }),
    );
    const args = [
      '-p',
      '--model', this.cfg.model ?? 'haiku',
      '--tools', '',
      '--strict-mcp-config',
      '--mcp-config', mcpConfig,
      '--allowedTools', 'mcp__sth',
      '--no-session-persistence',
      '--disable-slash-commands',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--system-prompt', systemPrompt(this.task),
    ];
    const proc = spawn(this.cfg.command ?? 'claude', args, { cwd: this.dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    const lines = new Lines();
    this.lines = lines;
    let buf = '';
    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (d: string) => {
      buf += d;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // not JSON (a warning): ignore
        }
      }
    });
    proc.stderr!.setEncoding('utf8');
    proc.stderr!.on('data', (d: string) => (this.stderr = (this.stderr + d).slice(-4000)));
    proc.on('exit', () => lines.end());
    proc.on('error', (e) => {
      this.stderr += String(e);
      lines.end();
    });
  }

  async *wake(ev: WakeEvent, signal: AbortSignal): AsyncIterable<BrainEvent> {
    if (!this.proc || this.proc.exitCode !== null || this.lines.ended) this.start();
    const proc = this.proc!;
    const lines = this.lines;
    const onAbort = () => {
      // ask Claude Code to stop the turn; if it does not, end the process (the next wake restarts it)
      proc.stdin?.write(`${JSON.stringify({ type: 'control_request', request_id: `int-${Date.now()}`, request: { subtype: 'interrupt' } })}\n`);
      setTimeout(() => {
        if (!lines.ended && signal.aborted) proc.kill();
      }, 3000).unref();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const text = withTask(wakeText(ev), this.taskNote);
    this.taskNote = null;
    proc.stdin!.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`);
    yield { type: 'status', text: 'thinking' };
    const toolNames = new Map<string, string>();
    try {
      for (;;) {
        const m = await lines.next();
        if (!m) {
          yield { type: 'turn_end', stop: signal.aborted ? 'cancelled' : 'error', error: this.stderr.trim().split('\n').pop() || 'claude exited' };
          return;
        }
        const t = m.type;
        if (t === 'stream_event') {
          const e = m.event as { type?: string; delta?: { type?: string; text?: string } };
          if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) yield { type: 'text_delta', delta: e.delta.text };
        } else if (t === 'assistant') {
          const content = ((m.message as { content?: Array<{ type: string; id?: string; name?: string }> })?.content ?? []).filter((c) => c.type === 'tool_use');
          for (const c of content) {
            const name = (c.name ?? '').replace(/^mcp__sth__/, '');
            if (c.id) toolNames.set(c.id, name);
            yield { type: 'tool', name, phase: 'start' };
          }
        } else if (t === 'user') {
          const content = ((m.message as { content?: Array<{ type: string; tool_use_id?: string; is_error?: boolean }> })?.content ?? []).filter(
            (c) => typeof c === 'object' && c.type === 'tool_result',
          );
          for (const c of content) yield { type: 'tool', name: toolNames.get(c.tool_use_id ?? '') ?? '', phase: 'end', ok: !c.is_error };
        } else if (t === 'result') {
          const isError = m.is_error === true || (typeof m.subtype === 'string' && m.subtype.startsWith('error'));
          if (signal.aborted) yield { type: 'turn_end', stop: 'cancelled' };
          else if (isError) yield { type: 'turn_end', stop: 'error', error: String(m.result ?? m.subtype ?? 'error') };
          else yield { type: 'turn_end', stop: 'done' };
          return;
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  async close(): Promise<void> {
    const p = this.proc;
    this.proc = null;
    if (p && p.exitCode === null) {
      p.stdin?.end();
      const exited = new Promise((r) => p.once('exit', r));
      const timer = setTimeout(() => p.kill(), 2000);
      await exited;
      clearTimeout(timer);
    }
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
  }
}
