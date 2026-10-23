// LAN HTTP server of the viewer (requirement 09 section 3.4): the viewing page, batch
// frames, and the browser WebSocket speaking the service protocol. Every request
// except the static page needs the access token.
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { serverHandshake, upgradeServer, type ServiceHost } from '@sth/wire';
import type { FrameFormat, FrameStore } from './frames.ts';
import type { WebAssets } from './web.ts';

export interface HttpOptions {
  host: string;
  port: number;
  token: () => string;
  browserHost: ServiceHost;
  frames: FrameStore;
  web: WebAssets;
  log: (...a: unknown[]) => void;
}

export interface HttpServer {
  port: number;
  close(): Promise<void>;
}

/** Failed token attempts per address: 10 failures lock the address out for a minute. */
class Lockout {
  private readonly fails = new Map<string, { n: number; until: number }>();

  blocked(addr: string): boolean {
    return this.remainingS(addr) > 0;
  }

  /** Seconds until the address may try again; 0 when it is not locked out. */
  remainingS(addr: string): number {
    const f = this.fails.get(addr);
    return f ? Math.max(0, Math.ceil((f.until - Date.now()) / 1000)) : 0;
  }

  result(addr: string, ok: boolean): void {
    if (ok) {
      this.fails.delete(addr);
      return;
    }
    const f = this.fails.get(addr) ?? { n: 0, until: 0 };
    f.n += 1;
    if (f.n >= 10) {
      f.until = Date.now() + 60_000;
      f.n = 0;
    }
    this.fails.set(addr, f);
  }
}

function tokenOk(expected: string, given: string | null | undefined): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
}

function securityHeaders(res: ServerResponse, host: string): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self' ws://${host} wss://${host}; frame-ancestors 'none'`,
  );
}

export async function startHttp(o: HttpOptions): Promise<HttpServer> {
  const lockout = new Lockout();
  const wss = upgradeServer();

  const server = createServer((req, res) => {
    const addr = req.socket.remoteAddress ?? '';
    const host = req.headers.host ?? '';
    securityHeaders(res, host);
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }).end(o.web.html);
      return;
    }
    if (url.pathname === '/app.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }).end(o.web.js);
      return;
    }
    if (url.pathname === '/lockout') {
      // a browser cannot read why a WebSocket upgrade was refused; this tells the page about
      // its own address only, so the page can say it is locked out instead of reconnecting
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ retry_after_s: lockout.remainingS(addr) }));
      return;
    }
    if (url.pathname === '/app.css') {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache' }).end(o.web.css);
      return;
    }
    const m = /^\/frame\/([^/]+)$/.exec(url.pathname);
    if (m) {
      let imageId: string;
      try {
        imageId = decodeURIComponent(m[1]);
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (lockout.blocked(addr)) {
        res.writeHead(429).end();
        return;
      }
      const ok = tokenOk(o.token(), bearer(req));
      lockout.result(addr, ok);
      if (!ok) {
        res.writeHead(401).end();
        return;
      }
      const width = Math.max(1, Math.min(8192, Number(url.searchParams.get('w')) || 1280));
      const saver = url.searchParams.get('saver') === '1';
      const format: FrameFormat = (url.searchParams.get('accept') ?? 'webp').split(',').includes('webp') ? 'webp' : 'jpeg';
      const p = o.frames.get(imageId, width, saver, format);
      if (!p) {
        res.writeHead(404).end();
        return;
      }
      p.then(
        (f) => res.writeHead(200, { 'content-type': f.type, 'cache-control': 'private, max-age=600', 'content-length': f.data.length }).end(f.data),
        (err) => {
          o.log('frame encode failed', String(err));
          res.writeHead(500).end();
        },
      );
      return;
    }
    res.writeHead(404).end();
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const addr = req.socket.remoteAddress ?? '';
    const url = new URL(req.url ?? '/', 'http://x');
    // same-origin only: a page on another site must not reach the viewer through the user's browser
    const origin = req.headers.origin;
    const sameOrigin = !!origin && !!req.headers.host && (origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`);
    if (url.pathname !== '/ws' || !sameOrigin || lockout.blocked(addr)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      serverHandshake(ws, {
        token: o.token(),
        onResult: (ok) => lockout.result(addr, ok),
        onConnection: (conn) => o.browserHost.attach(conn),
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, o.host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
