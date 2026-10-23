// normalize service: normalize.Normalize (spec 09 section 12).
import { runService, serve } from '@sth/service-kit';
import { ServiceHost } from '@sth/wire';
import { normalize, type NormalizeRequest } from './normalize.ts';

void runService('normalize', async (boot) => {
  const host = new ServiceHost().implement(boot.name, 'normalize', [1, 0], {
    async Normalize(stream) {
      const req = (await stream.recv()) as NormalizeRequest;
      await stream.send({ units: normalize(req) });
    },
  });
  return serve(boot, host, {
    name: boot.name,
    display_name: 'Normalization',
    interfaces: [{ name: 'normalize', major: 1, minor: 0 }],
    platform: { os: 'any', arch: 'any', accelerators: ['cpu'] },
  });
});
