// Bundle the Electron main process, the preload script and the window pages.
import { build } from 'esbuild';
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');
mkdirSync(join(out, 'renderer'), { recursive: true });

await build({
  entryPoints: [join(here, 'src/main/main.ts')],
  outfile: join(out, 'main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron', 'koffi', 'bufferutil', 'utf-8-validate'],
  sourcemap: true,
  logLevel: 'warning',
});

await build({
  entryPoints: [join(here, 'src/preload.ts')],
  outfile: join(out, 'preload.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  logLevel: 'warning',
});

const pages = readdirSync(join(here, 'src/renderer')).filter((f) => f.endsWith('.ts'));
await build({
  entryPoints: pages.map((p) => join(here, 'src/renderer', p)),
  outdir: join(out, 'renderer'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
  sourcemap: true,
  logLevel: 'warning',
});
for (const f of readdirSync(join(here, 'src/renderer')).filter((f) => f.endsWith('.html') || f.endsWith('.css'))) {
  cpSync(join(here, 'src/renderer', f), join(out, 'renderer', f));
}
cpSync(join(here, 'assets'), join(out, 'assets'), { recursive: true });
console.log('built', out);
