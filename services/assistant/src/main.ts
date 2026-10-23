// AI assistant service (spec 17 section 9): assistant.Session and assistant.Tools,
// plus ListSessionTools and CallTool for the MCP proxy of the Claude Code brain.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Clients, log, runService, serve } from '@sth/service-kit';
import { ServiceHost, type Stream } from '@sth/wire';
import { ClaudeCodeBrain, removeStaleDirs } from './brain-claude.ts';
import { PiBrain } from './brain-pi.ts';
import { makeGate } from './gate.ts';
import { Heartbeat } from './heartbeat.ts';
import { Platform } from './platform.ts';
import { AssistantSession } from './session.ts';
import { platformTools } from './tools.ts';
import type { Brain, SessionClientMessage, SessionServerMessage, ToolResult } from './types.ts';

export interface AssistantConfig {
  brain?: 'claude-code' | 'pi';
  model?: string;
  pi_provider?: string;
  pi_api_key?: string;
  pi_base_url?: string;
  heartbeat_ms?: number;
  gate?: 'rules' | 'jev' | 'composite';
  jev_api_key?: string;
  jev_base_url?: string;
  /** Process ids of the platform's own windows (the desktop app). */
  own_pids?: number[];
  /** Where pi keeps its files. */
  data_dir?: string;
  claude_command?: string;
}

void runService('assistant', async (boot) => {
  const cfg = boot.config as AssistantConfig;
  // one assistant service at a time: what an earlier, killed run left behind is stale
  removeStaleDirs();
  const sessions = new Map<string, AssistantSession>();
  let clients: Clients | null = null;
  let selfUrl = '';

  const describe = (tools: ReturnType<typeof platformTools>) => tools.map((t) => ({ name: t.name, label: t.label, description: t.description, parameters: t.parameters }));

  function makeBrain(name: string, sessionId: string): Brain {
    if (name === 'pi') {
      return new PiBrain({
        provider: cfg.pi_provider ?? 'anthropic',
        model: cfg.model ?? 'claude-haiku-4-5',
        api_key: cfg.pi_api_key,
        base_url: cfg.pi_base_url,
        dir: join(cfg.data_dir ?? process.cwd(), 'pi'),
      });
    }
    return new ClaudeCodeBrain({ model: cfg.model ?? 'haiku', command: cfg.claude_command, assistantUrl: selfUrl, token: boot.token, sessionId });
  }

  const host = new ServiceHost().implement(boot.name, 'assistant', [1, 0], {
    async Session(stream: Stream<SessionClientMessage, SessionServerMessage>) {
      const first = await stream.recv();
      if (!first || !('start' in first)) throw new Error('Session must begin with start');
      if (!clients) throw new Error('not registered yet');
      const start = first.start;
      let chain = Promise.resolve();
      const emit = (m: SessionServerMessage) => {
        chain = chain.then(() => stream.send(m)).catch(() => undefined);
      };
      const platform = new Platform(clients, start.range ?? {}, cfg.own_pids ?? []);
      const gateName = start.gate ?? cfg.gate ?? 'rules';
      const brainName = start.brain ?? cfg.brain ?? 'claude-code';
      const id = randomUUID(); // the Claude Code brain's MCP proxy calls back with it
      const session = new AssistantSession(
        start.task ?? '',
        {
          platform,
          heartbeat: new Heartbeat({ grab: async () => (await platform.grab()).image, ownPids: cfg.own_pids ?? [] }),
          gate: makeGate(gateName, { jev: { apiKey: cfg.jev_api_key, baseURL: cfg.jev_base_url } }),
          brain: makeBrain(brainName, id),
          heartbeatMs: start.heartbeat_ms ?? cfg.heartbeat_ms ?? 4000,
          emit,
          log: (...a) => log(boot.name, ...a),
        },
        id,
      );
      const s = session;
      sessions.set(s.id, s);
      log(boot.name, 'session', s.id, brainName, gateName);
      emit({ started: { session_id: s.id, brain: brainName, gate: gateName } });
      try {
        await s.start();
      } catch (err) {
        emit({ state: { state: 'stopped', reason: `could not start: ${(err as Error).message}` } });
        await s.stop();
        sessions.delete(s.id);
        await chain;
        return;
      }
      try {
        for await (const m of stream) {
          if ('user_message' in m) session.userMessage(m.user_message.text);
          else if ('pause' in m) session.pause();
          else if ('resume' in m) session.resume();
          else if ('clear_annotations' in m) await platform.clearAnnotations();
          else if ('set_task' in m) session.setTask(m.set_task.task);
          else if ('stop' in m) break;
        }
      } finally {
        await session.stop();
        sessions.delete(session.id);
        if (session.transcript.length && clients) {
          // requirement 01 section 8: the conversation goes to this computer's history
          await clients.agent
            .unary('agent', 'SaveHistory', { entry: { kind: 'assistant_session', session_id: session.id, task: session.task, transcript: session.transcript } })
            .catch(() => undefined);
        }
        await chain;
      }
    },
    async Tools(stream) {
      await stream.recv();
      await stream.send({ tools: describe(platformTools({ platform: null as never, task: () => '', recentGate: () => [], say: () => undefined })) });
    },
    async ListSessionTools(stream: Stream<{ session_id: string }, unknown>) {
      const req = await stream.recv();
      const s = req && sessions.get(req.session_id);
      if (!s) throw new Error('no such session');
      await stream.send({ tools: describe(s.tools) });
    },
    async CallTool(stream: Stream<{ session_id: string; name: string; args: Record<string, unknown> }, ToolResult>) {
      const req = await stream.recv();
      const s = req && sessions.get(req.session_id);
      if (!s) throw new Error('no such session');
      if (s.state === 'paused' || s.state === 'stopped') {
        await stream.send({ text: `The assistant is ${s.state}; tools are off.`, isError: true });
        return;
      }
      const tool = s.tools.find((t) => t.name === req.name);
      if (!tool) {
        await stream.send({ text: `unknown tool ${req.name}`, isError: true });
        return;
      }
      try {
        await stream.send(await tool.execute(req.args ?? {}, stream.signal));
      } catch (err) {
        await stream.send({ text: `${req.name} failed: ${(err as Error).message}`, isError: true });
      }
    },
  });

  const r = await serve(boot, host, {
    name: boot.name,
    display_name: 'AI assistant',
    interfaces: [{ name: 'assistant', major: 1, minor: 0 }],
    platform: { os: 'any', arch: 'any', accelerators: ['cpu'] },
  });
  selfUrl = r.url;
  if (r.agent) clients = new Clients(r.agent.conn, boot.token, boot.name);
  return {
    ...r,
    close: async () => {
      for (const s of sessions.values()) await s.stop();
      await clients?.closeAll();
      await r.close();
    },
  };
});
