// Compose a desktop screenshot with the overlay windows rendered by the app
// (overlays are excluded from real captures, so they are captured separately).
//   node tools/dev/compose.ts <desktop.png> <shots.json> <out.png>
import { readFileSync } from 'node:fs';
import sharp from 'sharp';

const [desk, shotsFile, out] = process.argv.slice(2);
const { shots } = JSON.parse(readFileSync(shotsFile, 'utf8').trim() /* trim also drops a BOM */) as { shots: Array<{ file: string; bounds: { x: number; y: number; width: number; height: number } }> };
const layers = [];
for (const s of shots) {
  // composed at the rendered size, as the layered window shows it; a size mismatch is a bug
  const meta = await sharp(s.file).metadata();
  if (meta.width !== s.bounds.width || meta.height !== s.bounds.height) console.warn(`${s.file}: rendered ${meta.width}x${meta.height}, window ${s.bounds.width}x${s.bounds.height}`);
  layers.push({ input: s.file, left: s.bounds.x, top: s.bounds.y });
}
await sharp(desk).composite(layers).png().toFile(out);
console.log(out, `${layers.length} overlay layer(s)`);
