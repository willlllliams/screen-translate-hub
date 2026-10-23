// Server side of services: dispatch opened streams to handlers by service,
// interface and method, checking interface versions (spec 00 section 3.6).
import type { Connection } from './connection.ts';
import type { OpenFrame } from './frames.ts';
import { OK, statusOf } from './status.ts';
import type { Stream } from './stream.ts';

export interface OpenInfo {
  svc: string;
  iface: string;
  maj: number;
  min: number;
  method: string;
  meta: Record<string, string>;
  conn: Connection;
}

// Handlers receive untyped streams; typed wrappers cast at the edge.
export type Handler = (stream: Stream<any, any>, info: OpenInfo) => Promise<void> | void;

interface IfaceImpl {
  ver: readonly [number, number];
  methods: Record<string, Handler>;
}

export function versionSatisfies(impl: readonly [number, number], required: readonly [number, number]): boolean {
  return impl[0] === required[0] && impl[1] >= required[1];
}

export class ServiceHost {
  private readonly services = new Map<string, Map<string, IfaceImpl>>();

  implement(svc: string, iface: string, ver: readonly [number, number], methods: Record<string, Handler>): this {
    let ifaces = this.services.get(svc);
    if (!ifaces) {
      ifaces = new Map();
      this.services.set(svc, ifaces);
    }
    ifaces.set(iface, { ver, methods });
    return this;
  }

  /** Service names hosted on this endpoint. */
  names(): string[] {
    return [...this.services.keys()];
  }

  interfacesOf(svc: string): Array<{ name: string; major: number; minor: number }> {
    const ifaces = this.services.get(svc);
    if (!ifaces) return [];
    return [...ifaces.entries()].map(([name, impl]) => ({ name, major: impl.ver[0], minor: impl.ver[1] }));
  }

  attach(conn: Connection): void {
    conn.onOpen = (frame, stream) => void this.dispatch(conn, frame, stream);
  }

  private async dispatch(conn: Connection, f: OpenFrame, stream: Stream): Promise<void> {
    const ifaces = this.services.get(f.svc);
    if (!ifaces) {
      stream.close({ code: 'unavailable', message: `no service ${f.svc}` });
      return;
    }
    const impl = ifaces.get(f.iface);
    if (!impl) {
      stream.close({ code: 'unimplemented', message: `${f.svc} does not implement ${f.iface}` });
      return;
    }
    if (!versionSatisfies(impl.ver, [f.maj, f.min])) {
      stream.close({ code: 'incompatible', message: `${f.iface} ${impl.ver.join('.')} cannot serve ${f.maj}.${f.min}` });
      return;
    }
    const handler = impl.methods[f.method];
    if (!handler) {
      stream.close({ code: 'unimplemented', message: `${f.iface}.${f.method}` });
      return;
    }
    const info: OpenInfo = { svc: f.svc, iface: f.iface, maj: f.maj, min: f.min, method: f.method, meta: f.meta ?? {}, conn };
    try {
      await handler(stream, info);
      stream.close(OK);
    } catch (err) {
      stream.close(statusOf(err));
    }
  }
}
