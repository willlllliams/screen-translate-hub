// The desktop agent's core (spec 01 section 2.1, spec 09 section 3): local service
// list, the `agent` interface, supervision, and hosting the system integration
// services the embedding app provides. Electron and the headless dev agent share it.
import type { ServiceManifest } from '@sth/model';
import { listen, RpcError, ServiceHost, type Handler, type Stream, type WireServer } from '@sth/wire';
import { randomBytes } from 'node:crypto';
import { Supervisor, type ServiceSpec } from './supervisor.ts';

export interface Registered {
  manifest: ServiceManifest;
  endpoint: string;
  stream: Stream;
}

export interface AgentHooks {
  notify?(kind: string, text: string, runId?: string): void;
  saveHistory?(entry: unknown): Promise<string>;
}

export interface AgentOptions {
  logDir: string;
  hooks?: AgentHooks;
  /** Reserved names resolved by this machine, e.g. bundled.ocr -> ocr.rapidocr. */
  aliases?: Record<string, string>;
}

type Waiter = (r: Registered) => void;

export class AgentCore {
  readonly token = randomBytes(32).toString('hex');
  readonly host = new ServiceHost();
  readonly supervisor: Supervisor;
  private server: WireServer | null = null;
  private readonly registered = new Map<string, Registered>();
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly acquirers = new Map<string, Set<Stream>>();
  private readonly sharingWatchers = new Set<Stream>();
  private sharing = false;
  private aliases: Record<string, string>;
  private readonly hooks: AgentHooks;

  constructor(opts: AgentOptions) {
    this.aliases = { ...(opts.aliases ?? {}) };
    this.hooks = opts.hooks ?? {};
    this.supervisor = new Supervisor({ agentUrl: () => this.url, token: this.token, logDir: opts.logDir });
    this.host.implement('agent', 'agent', [1, 0], {
      Register: (s) => this.onRegister(s),
      ListServices: (s) => this.onList(s),
      Acquire: (s) => this.onAcquire(s),
      WatchSharing: (s) => this.onWatchSharing(s),
      Notify: async (s) => {
        const m = (await s.recv()) as { kind: string; text: string; run_id?: string };
        this.hooks.notify?.(m.kind, m.text, m.run_id);
        await s.send({});
      },
      SaveHistory: async (s) => {
        const m = (await s.recv()) as { entry: unknown };
        const id = (await this.hooks.saveHistory?.(m.entry)) ?? '';
        await s.send({ entry_id: id });
      },
    });
  }

  get url(): string {
    if (!this.server) throw new Error('agent not started');
    return this.server.url;
  }

  /** Host a system integration service (overlay, card, region_select, ...) on the agent endpoint. */
  provide(svc: string, iface: string, methods: Record<string, Handler>, ver: readonly [number, number] = [1, 0]): void {
    this.host.implement(svc, iface, ver, methods);
  }

  define(spec: ServiceSpec): void {
    this.supervisor.define(spec);
  }

  setAlias(alias: string, target: string): void {
    this.aliases[alias] = target;
  }

  resolveName(name: string): string {
    return this.aliases[name] ?? name;
  }

  async start(): Promise<void> {
    this.server = await listen({ token: this.token, onConnection: (c) => this.host.attach(c) });
  }

  async stop(): Promise<void> {
    this.supervisor.stopAll();
    await this.server?.close();
  }

  // ---- sharing (spec 05 requirement section 4) ----

  get sharingEnabled(): boolean {
    return this.sharing;
  }

  setSharing(enabled: boolean): void {
    this.sharing = enabled;
    for (const s of this.sharingWatchers) void s.send({ enabled }).catch(() => this.sharingWatchers.delete(s));
  }

  // ---- service list ----

  list(): Registered[] {
    return [...this.registered.values()];
  }

  /** Resolve once the named service has registered (starting it if needed). */
  waitFor(name: string, timeoutMs = 60_000): Promise<Registered> {
    const real = this.resolveName(name);
    const hit = this.registered.get(real);
    if (hit) return Promise.resolve(hit);
    if (this.supervisor.has(real)) this.supervisor.ensure(real);
    else return Promise.reject(new RpcError('unavailable', `unknown service ${name}`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new RpcError('unavailable', `${real} did not register in time`)), timeoutMs);
      const list = this.waiters.get(real) ?? [];
      list.push((r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.waiters.set(real, list);
    });
  }

  private async onRegister(s: Stream): Promise<void> {
    const m = (await s.recv()) as { manifest: ServiceManifest; endpoint: string } | undefined;
    if (!m?.manifest?.name) throw new RpcError('invalid_argument', 'manifest required');
    const reg: Registered = { manifest: m.manifest, endpoint: m.endpoint, stream: s };
    this.registered.set(m.manifest.name, reg);
    await s.send({ result: { accepted: true } });
    for (const w of this.waiters.get(m.manifest.name)?.splice(0) ?? []) w(reg);
    // spec 09 section 3: re-registration is pushed to every holder of an Acquire stream
    for (const a of this.acquirers.get(m.manifest.name) ?? []) void a.send({ manifest: reg.manifest, endpoint: reg.endpoint }).catch(() => undefined);
    // the registration lives as long as this stream
    await s.done;
    if (this.registered.get(m.manifest.name) === reg) this.registered.delete(m.manifest.name);
  }

  private async onList(s: Stream): Promise<void> {
    const req = ((await s.recv()) ?? {}) as { interface?: string };
    const services = this.list()
      .filter((r) => !req.interface || r.manifest.interfaces.some((i) => i.name === req.interface))
      .map((r) => ({
        manifest: r.manifest,
        endpoint: r.endpoint,
        exposed: false,
        aliases: Object.entries(this.aliases).filter(([, v]) => v === r.manifest.name).map(([k]) => k),
        effective_limits: r.manifest.limits,
      }));
    const defined = this.supervisor
      .defined()
      .filter((d) => !this.registered.has(d.name))
      .map((d) => ({ manifest: { name: d.name, display_name: d.name, interfaces: [] }, endpoint: '', exposed: false, aliases: [] }));
    await s.send({ services: [...services, ...defined] });
  }

  private async onAcquire(s: Stream): Promise<void> {
    const req = (await s.recv()) as { service: string };
    const name = this.resolveName(req.service);
    const reg = await this.waitFor(name);
    let set = this.acquirers.get(name);
    if (!set) {
      set = new Set();
      this.acquirers.set(name, set);
    }
    set.add(s);
    await s.send({ manifest: reg.manifest, endpoint: reg.endpoint });
    await s.done;
    set.delete(s);
  }

  private async onWatchSharing(s: Stream): Promise<void> {
    await s.recv();
    this.sharingWatchers.add(s);
    await s.send({ enabled: this.sharing });
    await s.done;
    this.sharingWatchers.delete(s);
  }
}
