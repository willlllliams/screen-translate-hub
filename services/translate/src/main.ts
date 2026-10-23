// translate service: one process per translation source (spec 18 section 10).
// boot.config = { engine: "mock" | "claude-cli" | "openai" | "anthropic" | "bergamot", ...engine options }
import { log, runService, serve } from '@sth/service-kit';
import { RpcError, ServiceHost, statusOf } from '@sth/wire';
import { AnthropicEngine, type AnthropicConfig } from './anthropic.ts';
import { ClaudeCliEngine, type ClaudeCliConfig } from './claude-cli.ts';
import type { TranslateEngine, TranslateReply, TranslateRequest } from './engine.ts';
import { MockEngine, type MockConfig } from './mock.ts';
import { OpenAiEngine, type OpenAiConfig } from './openai.ts';

export async function createEngine(config: Record<string, unknown>): Promise<TranslateEngine> {
  switch (config.engine) {
    case 'mock':
      return new MockEngine(config as MockConfig);
    case 'claude-cli':
      return new ClaudeCliEngine(config as ClaudeCliConfig);
    case 'openai':
      return new OpenAiEngine(config as unknown as OpenAiConfig);
    case 'anthropic':
      return new AnthropicEngine(config as unknown as AnthropicConfig);
    case 'bergamot': {
      const { BergamotEngine } = await import('./bergamot.ts');
      return BergamotEngine.create(config);
    }
    default:
      throw new Error(`unknown translate engine: ${String(config.engine)}`);
  }
}

export function translateHost(name: string, engine: TranslateEngine): ServiceHost {
  return new ServiceHost().implement(name, 'translate', [1, 0], {
    async Translate(stream) {
      const req = (await stream.recv()) as TranslateRequest;
      if (!req?.segments) throw new RpcError('invalid_argument', 'segments required');
      try {
        await engine.translate(req, (r: TranslateReply) => stream.send(r), stream.signal);
      } catch (e) {
        const st = statusOf(e);
        if (st.code !== 'cancelled') log(name, 'translate failed', st);
        throw e;
      }
    },
  });
}

if (import.meta.main) {
  void runService('translate.mock', async (boot) => {
    const engine = await createEngine(boot.config);
    return serve(boot, translateHost(boot.name, engine), engine.manifest(boot.name));
  });
}
