// The v1 catalog of local services and how to start them (spec 18 section 2).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ServiceSpec } from './supervisor.ts';

export interface TranslatorConfig {
  /** Registered name, e.g. translate.claude-cli. */
  name: string;
  engine: 'claude-cli' | 'openai' | 'anthropic' | 'bergamot' | 'mock';
  [k: string]: unknown;
}

export interface CatalogOptions {
  root: string;
  node?: string;
  python?: string;
  translators: TranslatorConfig[];
  /** Replay frames instead of capturing the screen (headless tests). */
  replay?: { dir: string; interval_ms: number };
  /** Process ids whose windows the follow-active-window mode must skip. */
  excludePids?: number[];
  viewer?: { port: number; host: string; access_token: string };
  assistant?: Record<string, unknown>;
}

export function pythonPath(root: string): string {
  const venv = join(root, '.venv', 'Scripts', 'python.exe');
  return existsSync(venv) ? venv : 'python';
}

/**
 * An outbound proxy for one service (requirement 09 section 2: external AI services can
 * use their own proxy). Node 24's fetch follows these variables when NODE_USE_ENV_PROXY is set.
 */
export function proxyEnv(proxy: unknown): Record<string, string> | undefined {
  if (typeof proxy !== 'string' || !proxy) return undefined;
  return { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: proxy, HTTP_PROXY: proxy, NO_PROXY: '127.0.0.1,localhost' };
}

export function catalog(o: CatalogOptions): ServiceSpec[] {
  const node = o.node ?? process.execPath;
  const py = o.python ?? pythonPath(o.root);
  const pyCwd = join(o.root, 'services', 'py');
  const ts = (rel: string) => [join(o.root, rel)];
  const specs: ServiceSpec[] = [
    {
      name: 'capture',
      command: py,
      args: ['-X', 'utf8', '-m', 'capture.service'],
      cwd: pyCwd,
      config: { ...(o.replay ? { replay: o.replay } : {}), exclude_pids: o.excludePids ?? [] },
    },
    { name: 'ocr.rapidocr', command: py, args: ['-X', 'utf8', '-m', 'ocr.service'], cwd: pyCwd },
    { name: 'normalize', command: node, args: ts('services/normalize/src/main.ts'), cwd: o.root },
    { name: 'coordinator', command: node, args: ts('services/coordinator/src/main.ts'), cwd: o.root },
  ];
  for (const t of o.translators) {
    const { name, proxy, ...config } = t;
    specs.push({ name, command: node, args: ts('services/translate/src/main.ts'), cwd: o.root, config, env: proxyEnv(proxy) });
  }
  if (o.viewer && existsSync(join(o.root, 'services/viewer/src/main.ts'))) specs.push({ name: 'viewer', command: node, args: ts('services/viewer/src/main.ts'), cwd: o.root, config: o.viewer });
  if (o.assistant && existsSync(join(o.root, 'services/assistant/src/main.ts'))) {
    const { proxy, ...config } = o.assistant;
    specs.push({ name: 'assistant', command: node, args: ts('services/assistant/src/main.ts'), cwd: o.root, config, env: proxyEnv(proxy) });
  }
  return specs;
}
