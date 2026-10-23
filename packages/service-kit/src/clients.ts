// Service resolution through the desktop agent (spec 09 section 3) and a
// connection cache for directly connected local services (spec 08 section 8.3).
import type { ServiceManifest } from '@sth/model';
import { connect, Peer, RpcError, type Connection, type Stream } from '@sth/wire';

/** A resolved local service: its registered name, endpoint and description. */
export interface ResolvedService {
  /** Registered name, e.g. translate.claude-cli. */
  name: string;
  endpoint: string;
  manifest: ServiceManifest;
}

export interface LocalService {
  manifest: ServiceManifest;
  endpoint: string;
  exposed?: boolean;
  aliases?: string[];
  effective_limits?: ServiceManifest['limits'];
}

export class Clients {
  readonly agentConn: Connection;
  readonly agent: Peer;
  private readonly token: string;
  private readonly peerName: string;
  private readonly conns = new Map<string, Promise<Connection>>();
  private readonly acquired: Stream[] = [];

  constructor(agentConn: Connection, token: string, peerName: string) {
    this.agentConn = agentConn;
    this.agent = new Peer(agentConn, 'agent');
    this.token = token;
    this.peerName = peerName;
  }

  async listServices(iface?: string): Promise<LocalService[]> {
    const r = await this.agent.unary<{ interface?: string }, { services: LocalService[] }>('agent', 'ListServices', { interface: iface });
    return r.services;
  }

  /** agent.Acquire: start the service if needed and hold it until release(). */
  async acquire(name: string, timeoutMs = 60_000): Promise<ResolvedService> {
    const s = this.agent.open<{ manifest: ServiceManifest; endpoint: string }, { service: string }>('agent', 'Acquire', { deadlineMs: 0 });
    await s.send({ service: name });
    s.halfClose();
    const timer = setTimeout(() => s.cancel('acquire timeout'), timeoutMs);
    try {
      const first = await s.recv();
      if (!first) throw RpcError.from((await s.done) ?? { code: 'unavailable' });
      this.acquired.push(s);
      return { name: first.manifest.name, endpoint: first.endpoint, manifest: first.manifest };
    } finally {
      clearTimeout(timer);
    }
  }

  /** A peer for a service, on a cached connection to its endpoint. */
  async peer(svc: ResolvedService): Promise<Peer> {
    if (svc.endpoint === 'agent') return new Peer(this.agentConn, svc.name);
    let p = this.conns.get(svc.endpoint);
    if (p) {
      const c = await p.catch(() => null);
      if (c && c.isOpen) return new Peer(c, svc.name);
    }
    p = connect(svc.endpoint, { token: this.token, peer: this.peerName });
    this.conns.set(svc.endpoint, p);
    p.catch(() => this.conns.delete(svc.endpoint));
    return new Peer(await p, svc.name);
  }

  /** Peer for a system-integration service hosted by the agent (overlay, card, region_select). */
  agentService(name: string): Peer {
    return new Peer(this.agentConn, name);
  }

  release(): void {
    for (const s of this.acquired.splice(0)) s.cancel('released');
  }

  async closeAll(): Promise<void> {
    this.release();
    for (const p of this.conns.values()) (await p.catch(() => null))?.close();
    this.conns.clear();
  }
}
