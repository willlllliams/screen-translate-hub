// Common startup for TS service processes (spec 18 section 2.1); mirrors services/py/sth_service.
import type { ServiceManifest } from '@sth/model';
import { connect, listen, Peer, RpcError, type ServiceHost } from '@sth/wire';

export interface Boot {
  name: string;
  token: string;
  agent?: string;
  config: Record<string, unknown>;
}

export function log(name: string, ...args: unknown[]): void {
  const ts = new Date().toISOString();
  process.stderr.write(`${ts} ${name} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
}

/** Read boot info: `--standalone TOKEN [configJson]` for tests, else one JSON line on stdin. */
export async function readBoot(defaultName: string): Promise<Boot> {
  const argv = process.argv.slice(2);
  if (argv[0] === '--standalone') {
    return { name: defaultName, token: argv[1], config: argv[2] ? JSON.parse(argv[2]) : {} };
  }
  const line = await firstStdinLine();
  const data = JSON.parse(line) as Partial<Boot> & { token: string };
  return { name: data.name ?? defaultName, token: data.token, agent: data.agent, config: data.config ?? {} };
}

let stdinBuffer = '';
let stdinEnded = false;
const stdinEndWaiters: Array<() => void> = [];

function firstStdinLine(): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stdin.setEncoding('utf8');
    let done = false;
    process.stdin.on('data', (chunk: string) => {
      stdinBuffer += chunk;
      const i = stdinBuffer.indexOf('\n');
      if (!done && i >= 0) {
        done = true;
        resolve(stdinBuffer.slice(0, i));
        stdinBuffer = stdinBuffer.slice(i + 1);
      }
    });
    process.stdin.on('end', () => {
      stdinEnded = true;
      for (const w of stdinEndWaiters.splice(0)) w();
      if (!done) reject(new Error('stdin closed before boot line'));
    });
  });
}

function stdinClosed(): Promise<void> {
  if (stdinEnded) return Promise.resolve();
  return new Promise((r) => stdinEndWaiters.push(r));
}

export interface ServeResult {
  url: string;
  /** The agent, for services that call it (absent when running standalone). */
  agent?: Peer;
  /** Resolves when the agent connection or stdin goes away. */
  finished: Promise<void>;
  close(): Promise<void>;
}

/** Listen on a loopback port, register with the agent and keep the registration open. */
export async function serve(
  boot: Boot,
  host: ServiceHost,
  manifest: ServiceManifest,
  onSettings?: (settings: Record<string, unknown>) => void,
): Promise<ServeResult> {
  const server = await listen({ token: boot.token, onConnection: (c) => host.attach(c) });
  log(boot.name, 'listening on', server.url);
  if (!boot.agent) {
    process.stdout.write(`${server.url}\n`);
    const finished = (async () => {
      process.stdin.resume();
      process.stdin.on('end', () => {
        stdinEnded = true;
        for (const w of stdinEndWaiters.splice(0)) w();
      });
      await stdinClosed();
    })();
    return { url: server.url, finished, close: () => server.close() };
  }
  const conn = await connect(boot.agent, { token: boot.token, peer: boot.name });
  const reg = new Peer(conn, 'agent').bidi<{ manifest: ServiceManifest; endpoint: string }, Record<string, unknown>>('agent', 'Register');
  await reg.send({ manifest, endpoint: server.url });
  const first = (await reg.recv()) as { result?: { accepted?: boolean; reason?: string } } | undefined;
  if (!first?.result?.accepted) throw new RpcError('permission_denied', `registration refused: ${first?.result?.reason ?? ''}`);
  log(boot.name, 'registered');
  void (async () => {
    try {
      for await (const m of reg) if (onSettings && m && typeof m === 'object' && 'settings' in m) onSettings(m.settings as Record<string, unknown>);
    } catch {
      // registration stream ended
    }
  })();
  const finished = Promise.race([conn.closed.then(() => undefined), stdinClosed()]);
  return {
    url: server.url,
    agent: new Peer(conn, 'agent'),
    finished,
    close: async () => {
      conn.close();
      await server.close();
    },
  };
}

/** Run a service until the agent goes away, then exit (spec 12 section 1.2). */
export async function runService(name: string, start: (boot: Boot) => Promise<ServeResult>): Promise<void> {
  try {
    const boot = await readBoot(name);
    const r = await start(boot);
    await r.finished;
    log(name, 'agent gone, exiting');
    await r.close();
    process.exit(0);
  } catch (err) {
    log(name, 'fatal', err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  }
}

export { Clients, type LocalService, type ResolvedService } from './clients.ts';
