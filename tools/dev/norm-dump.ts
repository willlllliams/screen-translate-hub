// Normalize an OcrResult JSON (from ocr-dump.py) and print the units, one per line.
//   node tools/dev/norm-dump.ts ocr.json frameWidth frameHeight
import { readFileSync } from 'node:fs';
import type { OcrResult } from '@sth/model';
import { normalize } from '../../services/normalize/src/normalize.ts';

const [file, fw, fh] = process.argv.slice(2);
const ocr = JSON.parse(readFileSync(file, 'utf8').replace(/^\W*\{/, '{')) as OcrResult;
for (const r of ocr.regions) for (const b of r.blocks) {
  const q = b.quad;
  console.log(`  block ${b.block_id} [${Math.round(q[0].x)},${Math.round(q[0].y)} ${Math.round(q[2].x - q[0].x)}x${Math.round(q[2].y - q[0].y)}] ${b.text}`);
}
const units = normalize({ ocr, reused: [], first_id: 1, frame_width: Number(fw ?? 1366), frame_height: Number(fh ?? 768) });
for (const u of units) {
  const b = u.bounds!;
  console.log(`unit ${u.paragraph_id} [${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}x${Math.round(b.h)}] lines=${u.lines?.length} ${JSON.stringify(u.text)}`);
}
