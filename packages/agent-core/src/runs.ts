// Starting and controlling runs from the agent (spec 12 section 2.2): resolve the
// coordinator, send RunStart, relay status, accept controls.
import type { CaptureRange, Image } from '@sth/model';
import { connect, Peer, type Connection, type Stream } from '@sth/wire';
import type { WorkflowDoc } from '@sth/workflow';
import { randomUUID } from 'node:crypto';
import type { AgentCore } from './agent.ts';

export interface RunStatus {
  state: 'preparing' | 'running' | 'paused' | 'completed' | 'stopped' | 'failed';
  reason?: string;
}

export interface RunTrigger {
  continuous_range?: CaptureRange;
  image?: Image;
  anchor?: { x: number; y: number };
  range_label?: string;
}

export class RunHandle {
  readonly id: string;
  readonly entry: string;
  status: RunStatus = { state: 'preparing' };
  preflight?: { node_id: string; problem: string };
  private readonly stream: Stream;
  private readonly listeners: Array<(s: RunStatus) => void> = [];
  readonly finished: Promise<RunStatus>;

  constructor(id: string, entry: string, stream: Stream) {
    this.id = id;
    this.entry = entry;
    this.stream = stream;
    this.finished = (async () => {
      try {
        for await (const m of stream as Stream<{ status?: RunStatus; preflight_failed?: { node_id: string; problem: string } }, unknown>) {
          if (m.preflight_failed) this.preflight = m.preflight_failed;
          if (m.status) {
            this.status = m.status;
            for (const l of this.listeners) l(m.status);
          }
        }
      } catch {
        if (!['completed', 'stopped', 'failed'].includes(this.status.state)) this.status = { state: 'stopped', reason: 'coordinator unavailable' };
      }
      return this.status;
    })();
  }

  onStatus(cb: (s: RunStatus) => void): void {
    this.listeners.push(cb);
  }

  get active(): boolean {
    return ['preparing', 'running', 'paused'].includes(this.status.state);
  }

  control(action: Record<string, unknown>): Promise<void> {
    return this.stream.send({ control: action });
  }

  pause(): Promise<void> {
    return this.control({ pause: true });
  }

  resume(): Promise<void> {
    return this.control({ resume: true });
  }

  stop(): Promise<void> {
    return this.control({ stop: true });
  }
}

export class RunLauncher {
  private readonly agent: AgentCore;
  private conn: Connection | null = null;
  readonly deviceId: string;

  constructor(agent: AgentCore, deviceId: string) {
    this.agent = agent;
    this.deviceId = deviceId;
  }

  private async coordinator(): Promise<Peer> {
    const reg = await this.agent.waitFor('coordinator');
    if (!this.conn || !this.conn.isOpen) this.conn = await connect(reg.endpoint, { token: this.agent.token, peer: 'agent' });
    return new Peer(this.conn, reg.manifest.name);
  }

  async start(doc: WorkflowDoc, trigger: RunTrigger = {}): Promise<RunHandle> {
    const peer = await this.coordinator();
    const id = randomUUID();
    const stream = peer.bidi<unknown, unknown>('coordinator', 'Run', { deadlineMs: 0 });
    await stream.send({ start: { run_id: id, workflow: JSON.stringify(doc), entry: doc.entry, device_id: this.deviceId, ...trigger } });
    return new RunHandle(id, doc.entry, stream);
  }

  async details(runId: string): Promise<unknown> {
    const peer = await this.coordinator();
    return peer.unary('coordinator', 'GetRunDetails', { run_id: runId });
  }

  close(): void {
    this.conn?.close();
  }
}
