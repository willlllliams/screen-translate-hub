// pi brain (spec 17 section 5.2): a pi agent session inside this process. Only the
// platform tools are active (an explicit allowlist, so pi's read/bash/edit/write never
// load); the conversation lives in memory for the length of the assistant session.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { wakeText, withTask } from './brain-claude.ts';
import { systemPrompt } from './tools.ts';
import type { Brain, BrainEvent, PlatformTool, WakeEvent } from './types.ts';

export interface PiBrainConfig {
  /** pi provider id: anthropic, openai, google, ... or "custom" with base_url. */
  provider: string;
  model: string;
  api_key?: string;
  /** An OpenAI-compatible endpoint (Ollama, vLLM, a proxy): written into pi's models.json. */
  base_url?: string;
  /** Where pi keeps auth.json and models.json for this app (not ~/.pi). */
  dir: string;
}

class Queue<T> {
  private items: T[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;

  push(v: T): void {
    if (this.closed) return;
    this.items.push(v);
    for (const w of this.waiters.splice(0)) w();
  }

  close(last?: T): void {
    if (last !== undefined) this.push(last);
    this.closed = true;
    for (const w of this.waiters.splice(0)) w();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }
}

type PiSession = {
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(cb: (e: Record<string, any>) => void): () => void;
  dispose(): void;
  messages: Array<Record<string, any>>;
};

export class PiBrain implements Brain {
  readonly name = 'pi';
  private readonly cfg: PiBrainConfig;
  private session: PiSession | null = null;
  /** A task set after open(), not yet told to the model. */
  private taskNote: string | null = null;

  constructor(cfg: PiBrainConfig) {
    this.cfg = cfg;
  }

  async open(task: string, tools: PlatformTool[]): Promise<void> {
    const pi = await import('@earendil-works/pi-coding-agent');
    mkdirSync(this.cfg.dir, { recursive: true });
    const modelsPath = join(this.cfg.dir, 'models.json');
    const provider = this.cfg.base_url ? 'custom' : this.cfg.provider;
    writeFileSync(
      modelsPath,
      JSON.stringify(
        this.cfg.base_url
          ? { providers: { custom: { baseUrl: this.cfg.base_url, api: 'openai-completions', apiKey: this.cfg.api_key || 'none', models: [{ id: this.cfg.model, input: ['text', 'image'] }] } } }
          : { providers: {} },
      ),
    );
    const runtime = await pi.ModelRuntime.create({ authPath: join(this.cfg.dir, 'auth.json'), modelsPath });
    if (this.cfg.api_key && !this.cfg.base_url) await runtime.setRuntimeApiKey(provider, this.cfg.api_key);
    const model = runtime.getModel(provider, this.cfg.model);
    if (!model) throw new Error(`pi has no model ${provider}/${this.cfg.model}`);

    const prompt = systemPrompt(task);
    const resourceLoader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: pi.createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => prompt,
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
      extendResources: () => {},
      reload: async () => {},
    };
    const customTools = tools.map((t) => ({
      name: t.name,
      label: t.label,
      description: t.description,
      parameters: t.parameters as never,
      async execute(_id: string, params: unknown, signal: AbortSignal | undefined) {
        const r = await t.execute(params as Record<string, unknown>, signal);
        if (r.isError) throw new Error(r.text);
        return {
          content: [{ type: 'text' as const, text: r.text }, ...(r.images ?? []).map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType }))],
          details: {},
        };
      },
    }));
    const { session } = await pi.createAgentSession({
      cwd: this.cfg.dir,
      agentDir: this.cfg.dir,
      modelRuntime: runtime,
      model,
      thinkingLevel: 'off',
      resourceLoader: resourceLoader as never,
      tools: tools.map((t) => t.name),
      customTools: customTools as never,
      sessionManager: pi.SessionManager.inMemory(this.cfg.dir),
      settingsManager: pi.SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 1 } } as never),
    });
    this.session = session as unknown as PiSession;
  }

  setTask(task: string): void {
    this.taskNote = task;
  }

  async *wake(ev: WakeEvent, signal: AbortSignal): AsyncIterable<BrainEvent> {
    const session = this.session;
    if (!session) {
      yield { type: 'turn_end', stop: 'error', error: 'pi session not open' };
      return;
    }
    const q = new Queue<BrainEvent>();
    const unsubscribe = session.subscribe((e) => {
      if (e.type === 'message_update' && e.assistantMessageEvent?.type === 'text_delta') q.push({ type: 'text_delta', delta: e.assistantMessageEvent.delta });
      else if (e.type === 'tool_execution_start') q.push({ type: 'tool', name: e.toolName, phase: 'start' });
      else if (e.type === 'tool_execution_end') q.push({ type: 'tool', name: e.toolName, phase: 'end', ok: !e.isError });
    });
    const onAbort = () => void session.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    q.push({ type: 'status', text: 'thinking' });
    const text = withTask(wakeText(ev), this.taskNote);
    this.taskNote = null;
    session.prompt(text).then(
      () => {
        const last = session.messages.at(-1);
        if (signal.aborted) q.close({ type: 'turn_end', stop: 'cancelled' });
        else if (last?.role === 'assistant' && last.stopReason === 'error') q.close({ type: 'turn_end', stop: 'error', error: String(last.errorMessage ?? 'model error') });
        else q.close({ type: 'turn_end', stop: 'done' });
      },
      (err: Error) => q.close({ type: 'turn_end', stop: signal.aborted ? 'cancelled' : 'error', error: err.message }),
    );
    try {
      for await (const e of q) yield e;
    } finally {
      unsubscribe();
      signal.removeEventListener('abort', onAbort);
    }
  }

  async close(): Promise<void> {
    this.session?.dispose();
    this.session = null;
  }
}
