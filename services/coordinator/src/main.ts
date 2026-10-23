// coordinator service: coordinator.Run and coordinator.GetRunDetails (spec 09 section 16).
import { log, runService, serve } from '@sth/service-kit';
import { connect, ServiceHost, type Stream } from '@sth/wire';
import { Availability } from './availability.ts';
import { Clients } from './clients.ts';
import { ServiceQueue } from './queue.ts';
import { Run, type Control, type RunStart, type Shared } from './run.ts';
import type { ResolvedService } from './types.ts';

type RunClientMessage = { start?: RunStart; control?: Control };

export function coordinatorHost(name: string, clients: Clients): ServiceHost {
  const queues = new Map<string, ServiceQueue>();
  const shared: Shared = {
    availability: new Availability(),
    queueFor(svc: ResolvedService) {
      let q = queues.get(svc.name);
      if (!q) {
        const l = svc.manifest.limits ?? {};
        q = new ServiceQueue({ concurrency: l.max_concurrency ?? 2, ratePerSec: l.requests_per_second ?? 5, burst: l.burst ?? 2 });
        queues.set(svc.name, q);
      }
      return q;
    },
  };
  const runs = new Map<string, Run>();

  async function handleRun(stream: Stream<RunClientMessage, unknown>): Promise<void> {
    const first = await stream.recv();
    if (!first?.start) throw new Error('Run must begin with RunStart');
    let chain = Promise.resolve();
    const send = (m: unknown) => {
      chain = chain.then(() => stream.send(m)).catch(() => undefined);
    };
    const run = new Run(
      first.start,
      clients,
      {
        status: (state, reason) => send({ status: { state, reason } }),
        notify: (kind, text) => void clients.agent.unary('agent', 'Notify', { kind, run_id: first.start!.run_id, text }).catch(() => undefined),
        preflightFailed: (node, problem) => send({ preflight_failed: { node_id: node, problem } }),
      },
      shared,
    );
    runs.set(run.id, run);
    log(name, 'run', run.id, first.start.entry);
    if (!(await run.prepare())) {
      await chain;
      return;
    }
    const exec = run.execute();
    void (async () => {
      try {
        for await (const m of stream) if (m.control) await run.control(m.control);
      } catch {
        // controlling stream gone
      }
      // spec 04 section 12: a local run cannot continue without the agent that started it
      if (run.state === 'running' || run.state === 'paused') await run.stop('agent disconnected');
    })();
    await exec;
    await run.ended;
    await chain;
    // keep finished runs around briefly for GetRunDetails
    setTimeout(() => runs.delete(run.id), 10 * 60_000).unref();
  }

  return new ServiceHost().implement(name, 'coordinator', [1, 0], {
    Run: (stream) => handleRun(stream as Stream<RunClientMessage, unknown>),
    async GetRunDetails(stream) {
      const req = (await stream.recv()) as { run_id: string; kind?: string };
      const run = runs.get(req.run_id);
      await stream.send({ events: run ? run.details.list({ kind: req.kind }) : [], state: run?.state ?? 'unknown' });
    },
    /** The display state of a run, by default the newest active continuous run (for the AI assistant). */
    async GetDisplay(stream) {
      const req = ((await stream.recv()) ?? {}) as { run_id?: string };
      const active = (r: Run) => r.state === 'running' || r.state === 'paused';
      const run = req.run_id ? runs.get(req.run_id) : [...runs.values()].reverse().find((r) => active(r) && r.plan?.entry === 'continuous');
      await stream.send({ run_id: run?.id ?? null, state: run?.state ?? null, snapshot: run?.displaySnapshot() ?? null });
    },
  });
}

if (import.meta.main) {
  void runService('coordinator', async (boot) => {
    if (!boot.agent) throw new Error('the coordinator needs an agent');
    const agentConn = await connect(boot.agent, { token: boot.token, peer: `${boot.name}:client` });
    const clients = new Clients(agentConn, boot.token, boot.name);
    return serve(boot, coordinatorHost(boot.name, clients), {
      name: boot.name,
      display_name: 'Run coordinator',
      interfaces: [{ name: 'coordinator', major: 1, minor: 0 }],
      platform: { os: 'any', arch: 'any', accelerators: ['cpu'] },
    });
  });
}
