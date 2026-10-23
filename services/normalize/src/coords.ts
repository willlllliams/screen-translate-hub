// Spec 06 section 2: region coordinates back to frame pixels.
import type { OcrRegion, Quad, TextBlock } from '@sth/model';

export function quadToFrame(q: Quad, ox: number, oy: number, s: number): Quad {
  return q.map((p) => ({ x: ox + p.x / s, y: oy + p.y / s })) as Quad;
}

export function toFrameCoords(region: OcrRegion, block: TextBlock): TextBlock {
  const s = region.scale || 1;
  const { x: ox, y: oy } = region.rect;
  const out: TextBlock = { ...block, quad: quadToFrame(block.quad, ox, oy, s) };
  if (block.char_quads) out.char_quads = block.char_quads.map((q) => quadToFrame(q, ox, oy, s));
  return out;
}
