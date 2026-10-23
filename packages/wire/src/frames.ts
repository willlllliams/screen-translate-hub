// Frames of the v1 wire encoding (spec 18 section 3): one MessagePack map per
// WebSocket binary message. Semantics follow spec 08.
import { decode, encode } from '@msgpack/msgpack';
import type { StatusCode } from './status.ts';

export const PROTOCOL_VERSION: readonly [number, number] = [1, 0];

export type PeerKind = 'local' | 'browser';
export type AckCode = 'INVALID_CREDENTIAL' | 'PROTOCOL_INCOMPATIBLE' | 'UNAVAILABLE' | 'REVOKED';

export interface HelloFrame { t: 'hello'; ver: [number, number]; kind: PeerKind; peer: string; token?: string }
export interface AckFrame { t: 'ack'; ok: boolean; code?: AckCode; reason?: string }
export interface OpenFrame {
  t: 'open';
  s: number;
  svc: string;
  iface: string;
  maj: number;
  min: number;
  method: string;
  /** Remaining time in ms when sent; 0 means no deadline. */
  dl: number;
  meta?: Record<string, string>;
}
export interface MsgFrame { t: 'msg'; s: number; b: unknown }
export interface HalfFrame { t: 'half'; s: number }
export interface CloseFrame { t: 'close'; s: number; code: StatusCode; msg?: string; retry?: number }
export interface CancelFrame { t: 'cancel'; s: number; reason: string }
export interface CreditFrame { t: 'credit'; s: number; n: number }
export interface PingFrame { t: 'ping'; n: number }
export interface PongFrame { t: 'pong'; n: number }

export type Frame =
  | HelloFrame
  | AckFrame
  | OpenFrame
  | MsgFrame
  | HalfFrame
  | CloseFrame
  | CancelFrame
  | CreditFrame
  | PingFrame
  | PongFrame;

export type StreamFrame = OpenFrame | MsgFrame | HalfFrame | CloseFrame | CancelFrame | CreditFrame;

export function encodeFrame(f: Frame): Uint8Array {
  return encode(f, { ignoreUndefined: true });
}

export function decodeFrame(data: Uint8Array): Frame {
  const f = decode(data) as Frame;
  if (!f || typeof f !== 'object' || typeof (f as { t?: unknown }).t !== 'string') {
    throw new Error('malformed frame');
  }
  return f;
}

export function isStreamFrame(f: Frame): f is StreamFrame {
  return typeof (f as { s?: unknown }).s === 'number';
}
