// WebSocket transport and handshake (spec 08 section 3, spec 18 section 3).
import { timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { Connection } from './connection.ts';
import { decodeFrame, encodeFrame, PROTOCOL_VERSION, type AckFrame, type HelloFrame, type PeerKind } from './frames.ts';
import { RpcError } from './status.ts';

export const SUBPROTOCOL = 'sth.v1-lite';
export const MAX_PAYLOAD = 64 * 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 5_000;

export interface ListenOptions {
  host?: string;
  port?: number;
  /** Local session token every peer must present. */
  token: string;
  /** Called after a successful handshake. */
  onConnection: (conn: Connection, hello: HelloFrame) => void;
}

export interface WireServer {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function tokenMatches(expected: string, given: string | undefined): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface HandshakeOptions {
  /** The token the peer must present: the local session token, or a viewer access token. */
  token: string;
  onConnection: (conn: Connection, hello: HelloFrame) => void;
  /** Called with the outcome of each handshake, e.g. to rate-limit failed attempts. */
  onResult?: (ok: boolean) => void;
}

/** Server side of the handshake on an accepted socket (spec 08 section 3). */
export function serverHandshake(ws: WebSocket, opts: HandshakeOptions): void {
  let conn: Connection | null = null;
  const timer = setTimeout(() => ws.close(1008, 'handshake timeout'), HANDSHAKE_TIMEOUT_MS);
  ws.on('message', (data) => {
    const bytes = toBytes(data);
    if (conn) {
      conn.receive(bytes);
      return;
    }
    clearTimeout(timer);
    let hello: HelloFrame;
    try {
      const f = decodeFrame(bytes);
      if (f.t !== 'hello') throw new Error('expected hello');
      hello = f;
    } catch {
      ws.close(1002, 'bad handshake');
      return;
    }
    const reject = (ack: AckFrame) => {
      ws.send(encodeFrame(ack));
      ws.close(1008, ack.code);
    };
    if (!Array.isArray(hello.ver) || hello.ver[0] !== PROTOCOL_VERSION[0]) {
      reject({ t: 'ack', ok: false, code: 'PROTOCOL_INCOMPATIBLE', reason: `server speaks ${PROTOCOL_VERSION.join('.')}` });
      return;
    }
    if (!tokenMatches(opts.token, hello.token)) {
      opts.onResult?.(false);
      reject({ t: 'ack', ok: false, code: 'INVALID_CREDENTIAL' });
      return;
    }
    opts.onResult?.(true);
    ws.send(encodeFrame({ t: 'ack', ok: true }));
    conn = new Connection({ send: (d) => ws.send(d), close: (c, r) => ws.close(c, r) }, false, {
      kind: hello.kind,
      name: hello.peer,
    });
    ws.on('close', () => conn?.lost('peer closed'));
    opts.onConnection(conn, hello);
  });
  ws.on('error', () => conn?.lost('socket error'));
  ws.on('close', () => clearTimeout(timer));
}

/** A WebSocket server without its own port, for upgrades on an existing HTTP server. */
export function upgradeServer(): WebSocketServer {
  return new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
  });
}

export async function listen(opts: ListenOptions): Promise<WireServer> {
  const host = opts.host ?? '127.0.0.1';
  const wss = new WebSocketServer({
    host,
    port: opts.port ?? 0,
    maxPayload: MAX_PAYLOAD,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
  });
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  const port = (wss.address() as AddressInfo).port;

  wss.on('connection', (ws, req) => {
    // Browsers never speak to local endpoints; refuse any request carrying an Origin.
    if (req.headers.origin) {
      ws.close(1008, 'origin not allowed');
      return;
    }
    serverHandshake(ws, { token: opts.token, onConnection: opts.onConnection });
  });

  return {
    port,
    url: `ws://${host}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      }),
  };
}

export interface ConnectOptions {
  token: string;
  peer: string;
  kind?: PeerKind;
  timeoutMs?: number;
}

export async function connect(url: string, opts: ConnectOptions): Promise<Connection> {
  const ws = new WebSocket(url, SUBPROTOCOL, { maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
  ws.binaryType = 'nodebuffer';
  return new Promise<Connection>((resolve, reject) => {
    let conn: Connection | null = null;
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new RpcError('unavailable', `connect timeout: ${url}`));
    }, opts.timeoutMs ?? HANDSHAKE_TIMEOUT_MS);
    ws.once('open', () => {
      const hello: HelloFrame = {
        t: 'hello',
        ver: [PROTOCOL_VERSION[0], PROTOCOL_VERSION[1]],
        kind: opts.kind ?? 'local',
        peer: opts.peer,
        token: opts.token,
      };
      ws.send(encodeFrame(hello));
    });
    ws.on('message', (data) => {
      const bytes = toBytes(data);
      if (conn) {
        conn.receive(bytes);
        return;
      }
      clearTimeout(timer);
      let ack: AckFrame;
      try {
        const f = decodeFrame(bytes);
        if (f.t !== 'ack') throw new Error('expected ack');
        ack = f;
      } catch {
        ws.terminate();
        reject(new RpcError('unavailable', 'bad handshake reply'));
        return;
      }
      if (!ack.ok) {
        ws.terminate();
        reject(new RpcError('unauthenticated', `${ack.code ?? 'rejected'}${ack.reason ? `: ${ack.reason}` : ''}`));
        return;
      }
      conn = new Connection({ send: (d) => ws.send(d), close: (c, r) => ws.close(c, r) }, true, {
        kind: 'local',
        name: url,
      });
      resolve(conn);
    });
    ws.on('close', () => {
      clearTimeout(timer);
      if (conn) conn.lost('peer closed');
      else reject(new RpcError('unavailable', `connection refused: ${url}`));
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      if (conn) conn.lost(err.message);
      else reject(new RpcError('unavailable', `${url}: ${err.message}`));
    });
  });
}
