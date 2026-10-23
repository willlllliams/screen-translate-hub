// The viewing page: bundled from web/ when the service starts (esbuild, in memory),
// or read from web/dist when a packaged build ships it prebuilt.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface WebAssets {
  html: string;
  js: string;
  css: string;
}

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

export async function buildWeb(): Promise<WebAssets> {
  const html = readFileSync(join(webDir, 'index.html'), 'utf8');
  const css = readFileSync(join(webDir, 'app.css'), 'utf8');
  const prebuilt = join(webDir, 'dist', 'app.js');
  if (existsSync(prebuilt)) return { html, css, js: readFileSync(prebuilt, 'utf8') };
  const esbuild = await import('esbuild');
  const out = await esbuild.build({
    entryPoints: [join(webDir, 'app.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    target: ['es2020', 'chrome90', 'safari15', 'firefox90'],
    minify: true,
    legalComments: 'none',
  });
  return { html, css, js: out.outputFiles[0].text };
}
