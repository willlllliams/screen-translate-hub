// Display ends reached over the service protocol: the agent's overlay and card
// services (spec 09 sections 7 and 8) and the viewer's Publish (section 19).
import type { CaptureRange, DisplayEvent, DisplaySnapshot, Image } from '@sth/model';
import type { Peer } from '@sth/wire';
import type { DisplaySink } from './display.ts';

export function overlaySink(peer: Peer, start: { run_id: string; stream_id: string; range?: CaptureRange; target_language: string }): DisplaySink {
  const call = peer.open<unknown, unknown>('overlay', 'Attach', { deadlineMs: 0 });
  return {
    async open(snapshot: DisplaySnapshot) {
      await call.send({ start });
      await call.send({ snapshot });
    },
    async event(e: DisplayEvent) {
      await call.send({ event: e });
    },
    close() {
      call.halfClose();
    },
  };
}

export function cardSink(
  peer: Peer,
  start: { run_id: string; stream_id: string; image?: Image; target_language: string; anchor?: { x: number; y: number }; reuse_card_id?: string },
  onClosed?: () => void,
): DisplaySink {
  const call = peer.open<{ opened?: unknown; closed?: unknown }, unknown>('card', 'Open', { deadlineMs: 0 });
  void (async () => {
    try {
      for await (const m of call) if (m && 'closed' in m) onClosed?.();
    } catch {
      // card stream ended
    }
  })();
  return {
    async open(snapshot: DisplaySnapshot) {
      await call.send({ start: { kind: 'screenshot', ...start } });
      await call.send({ snapshot });
    },
    async event(e: DisplayEvent) {
      await call.send({ display: e });
    },
    close() {
      call.halfClose();
    },
  };
}

export function viewerSink(
  peer: Peer,
  start: { run_id: string; stream_id: string; device_id: string; range_label: string; target_language: string },
  onEnded?: () => void,
): DisplaySink {
  const call = peer.open<unknown, unknown>('viewer', 'Publish', { deadlineMs: 0 });
  void call.done.then(() => onEnded?.());
  return {
    async open(snapshot: DisplaySnapshot, frame?: { id: string; seq: number; image: Image }) {
      await call.send({ start });
      if (frame) await call.send({ frame: { image_id: frame.id, batch_seq: frame.seq, image: frame.image } });
      await call.send({ snapshot });
    },
    async event(e: DisplayEvent) {
      await call.send({ event: e });
    },
    async frame(imageId: string, batchSeq: number, image: Image) {
      await call.send({ frame: { image_id: imageId, batch_seq: batchSeq, image } });
    },
    close() {
      call.halfClose();
    },
  };
}
