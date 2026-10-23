// Browser side of the service protocol (spec 08 section 3, kind "browser"): the same
// connection, streams and flow control over the native WebSocket. No Node imports.
import { Connection } from './connection.ts';
import { decodeFrame, encodeFrame, PROTOCOL_VERSION, type HelloFrame } from './frames.ts';
import { RpcError } from './status.ts';

export * from './status.ts';
export * from './frames.ts';
export * from './stream.ts';
export * from './connection.ts';
export * from './client.ts';

export const SUBPROTOCOL = 'sth.v1-lite';

export function connectBrowser(url: string, token: string, peer = 'browser', timeoutMs = 8000): Promise<Connection> {
  const ws = new WebSocket(url, SUBPROTOCOL);
  ws.binaryType = 'arraybuffer';
  return new Promise<Connection>((resolve, reject) => {
    let conn: Connection | null = null;
    const timer = setTimeout(() => {
      ws.close();
      reject(new RpcError('unavailable', 'connect timeout'));
    }, timeoutMs);
    ws.onopen = () => {
      const hello: HelloFrame = { t: 'hello', ver: [PROTOCOL_VERSION[0], PROTOCOL_VERSION[1]], kind: 'browser', peer, token };
      ws.send(encodeFrame(hello) as Uint8Array<ArrayBuffer>);
    };
    ws.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      const bytes = new Uint8Array(e.data);
      if (conn) {
        conn.receive(bytes);
        return;
      }
      clearTimeout(timer);
      const f = decodeFrame(bytes);
      if (f.t !== 'ack' || !f.ok) {
        ws.close();
        reject(new RpcError('unauthenticated', f.t === 'ack' ? (f.code ?? 'rejected') : 'bad handshake reply'));
        return;
      }
      // browsers accept only 1000 and 3000-4999 as close codes
      const close = (c?: number, r?: string) => ws.close(c === 1000 || (c !== undefined && c >= 3000 && c <= 4999) ? c : 1000, r);
      conn = new Connection({ send: (d) => ws.send(d as Uint8Array<ArrayBuffer>), close }, true, { kind: 'browser', name: url });
      resolve(conn);
    };
    ws.onclose = () => {
      clearTimeout(timer);
      if (conn) conn.lost('closed');
      else reject(new RpcError('unavailable', 'connection refused'));
    };
  });
}
