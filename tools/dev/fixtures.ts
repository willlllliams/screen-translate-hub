// Test frames rendered from SVG text (spec 16 section 1.2 dynamic samples).
//   node tools/dev/fixtures.ts <outDir>
// Produces: 01-doc.png, 02-doc-scrolled.png (content moved up, a new line at the
// bottom), 03-other-page.png, 04-back.png (the first page again).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

export const W = 960;
export const H = 540;

const PARAGRAPHS = [
  ['The memory tool lets the assistant store and consult', 'information across conversations.'],
  ['Context editing clears older tool results automatically', 'when the conversation approaches its token limit.'],
  ['A new stop reason tells you when the model has used', 'the whole context window.'],
  ['Global endpoint pricing now applies to cloud platforms.'],
  ['Read the release notes for every change in this version.'],
];
const OTHER = [
  ['Settings'],
  ['Choose how often the screen is captured and how long', 'a batch may take before it is cut off.'],
  ['Translation sources run in parallel and the preferred', 'source always has the final word.'],
];

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function page(paragraphs: string[][], offset: number, extra?: string): string {
  const lines: string[] = [];
  let y = 110 - offset;
  for (const p of paragraphs) {
    for (const l of p) {
      if (y > 70 && y < H - 10) lines.push(`<text x="60" y="${y}" font-family="Arial" font-size="22" fill="#111">${esc(l)}</text>`);
      y += 30;
    }
    y += 22;
  }
  if (extra) lines.push(`<text x="60" y="${y}" font-family="Arial" font-size="22" fill="#111">${esc(extra)}</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<rect width="100%" height="100%" fill="#ffffff"/>
<rect width="100%" height="56" fill="#e8e8ec"/>
<text x="24" y="36" font-family="Arial" font-size="20" fill="#333">Release notes</text>
${lines.join('\n')}
</svg>`;
}

export async function renderFrames(dir: string): Promise<string[]> {
  mkdirSync(dir, { recursive: true });
  const frames: Array<[string, string]> = [
    ['01-doc.png', page(PARAGRAPHS, 0)],
    ['02-doc-scrolled.png', page(PARAGRAPHS, 52, 'This line scrolled into view.')],
    ['03-other-page.png', page(OTHER, 0)],
    ['04-back.png', page(PARAGRAPHS, 0)],
  ];
  const out: string[] = [];
  for (const [name, svg] of frames) {
    const file = join(dir, name);
    await sharp(Buffer.from(svg)).png().toFile(file);
    out.push(file);
  }
  return out;
}

/** BGRA raw image of a PNG, as the capture service would deliver it. */
export async function bgraOf(file: string): Promise<{ width: number; height: number; data: Uint8Array }> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    out[i] = data[i + 2];
    out[i + 1] = data[i + 1];
    out[i + 2] = data[i];
    out[i + 3] = 255;
  }
  return { width: info.width, height: info.height, data: out };
}

if (import.meta.main) {
  const dir = process.argv[2] ?? 'tmp/fixtures';
  console.log(await renderFrames(dir));
}
