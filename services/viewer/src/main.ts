// LAN viewer service (spec 09 section 19, requirement 09 section 3.4). The local
// endpoint takes Publish and SetSharing from the run coordinator and the agent; the
// LAN HTTP server serves the page, frames and the browser side (ListSources, Subscribe).
import { hostname } from 'node:os';
import { log, runService, serve } from '@sth/service-kit';
import { ServiceHost, type Stream } from '@sth/wire';
import type { DisplayEvent, DisplaySnapshot, Image } from '@sth/model';
import { FrameStore } from './frames.ts';
import { startHttp } from './http.ts';
import { SourceRegistry, type PublishStart, type SourceInfo, type SubscribeReply } from './sources.ts';
import { buildWeb } from './web.ts';

interface ViewerConfig {
  host?: string;
  port?: number;
  access_token?: string;
}

type PublishMessage =
  | { start: PublishStart }
  | { frame: { image_id: string; batch_seq: number; image: Image } }
  | { snapshot: DisplaySnapshot }
  | { event: DisplayEvent };

void runService('viewer', async (boot) => {
  const cfg = boot.config as ViewerConfig;
  let token = cfg.access_token ?? '';
  if (!token) throw new Error('viewer needs an access_token');
  const registry = new SourceRegistry(hostname());
  const frames = new FrameStore((id) => registry.frame(id));
  registry.onFramesDropped = (ids) => frames.drop(ids);
  let sharing = true;

  const local = new ServiceHost().implement(boot.name, 'viewer', [1, 0], {
    async Publish(stream: Stream<PublishMessage, unknown>) {
      let src: ReturnType<SourceRegistry['add']> | null = null;
      try {
        for await (const m of stream) {
          if ('start' in m) {
            if (!sharing) {
              stream.close({ code: 'permission_denied', message: 'screen sharing is off' });
              return;
            }
            src = registry.add(m.start);
            log(boot.name, 'source online', m.start.range_label);
          } else if (!src) {
            continue;
          } else if ('frame' in m) {
            src.putFrame(m.frame.image_id, m.frame.image);
          } else if ('snapshot' in m) {
            src.setSnapshot(m.snapshot);
          } else if ('event' in m) {
            src.event(m.event);
          }
        }
      } finally {
        if (src) {
          registry.remove(src);
          log(boot.name, 'source offline', src.info.range_label);
        }
      }
    },
    async SetSharing(stream: Stream<{ enabled: boolean }, unknown>) {
      const m = await stream.recv();
      setSharing(!!m?.enabled);
      await stream.send({});
    },
    async SetAccessToken(stream: Stream<{ access_token: string }, unknown>) {
      const m = await stream.recv();
      if (m?.access_token) token = m.access_token;
      await stream.send({});
    },
  });

  function setSharing(on: boolean): void {
    if (on === sharing) return;
    sharing = on;
    if (!on) registry.clear(); // sources go offline at once, frames are dropped (requirement 05 section 4.3)
  }

  const browser = new ServiceHost().implement('viewer', 'viewer', [1, 0], {
    async ListSources(stream: Stream<unknown, { sources: SourceInfo[] }>) {
      await stream.recv();
      let chain = Promise.resolve();
      const stop = registry.watch((list) => {
        chain = chain.then(() => stream.send({ sources: list })).catch(() => undefined);
      });
      await stream.done;
      stop();
    },
    async Subscribe(stream: Stream<{ source_id: string }, SubscribeReply>) {
      const req = await stream.recv();
      const src = req && registry.get(req.source_id);
      if (!src) {
        stream.close({ code: 'not_found', message: 'no such source' });
        return;
      }
      // spec 09 section 19: a subscriber out of credit is marked behind; once it catches up it
      // gets a fresh snapshot and continues from the latest state
      let behind = false;
      let ended = false;
      const unsubscribe = src.subscribe({
        deliver(m) {
          if (ended) return;
          if ('offline' in m) {
            ended = true;
            void stream.send(m).then(() => stream.close(), () => undefined);
            return;
          }
          if (behind) return;
          if (stream.writable) {
            void stream.send(m).catch(() => undefined);
            return;
          }
          behind = true;
          void stream.whenWritable().then(() => {
            behind = false;
            if (!stream.isFinished && !ended) void stream.send({ snapshot: src.snapshot() }).catch(() => undefined);
          });
        },
      });
      await stream.send({ snapshot: src.snapshot() });
      await stream.done;
      ended = true;
      unsubscribe();
    },
  });

  const web = await buildWeb();
  const http = await startHttp({
    host: cfg.host ?? '0.0.0.0',
    port: cfg.port ?? 8848,
    token: () => token,
    browserHost: browser,
    frames,
    web,
    log: (...a) => log(boot.name, ...a),
  });
  log(boot.name, `LAN page on ${cfg.host ?? '0.0.0.0'}:${http.port}`);

  const r = await serve(boot, local, {
    name: boot.name,
    display_name: 'LAN viewer',
    interfaces: [{ name: 'viewer', major: 1, minor: 0 }],
    platform: { os: 'any', arch: 'any', accelerators: ['cpu'] },
  });

  // follow the sharing switch (requirement 05 section 4.3) in addition to SetSharing
  if (r.agent) {
    const agent = r.agent;
    void (async () => {
      try {
        for await (const m of agent.serverStream<unknown, { enabled: boolean }>('agent', 'WatchSharing', {}, { deadlineMs: 0 })) setSharing(!!m.enabled);
      } catch {
        // agent gone: the service exits through runService
      }
    })();
  }

  return {
    ...r,
    close: async () => {
      registry.clear();
      await http.close();
      await r.close();
    },
  };
});
