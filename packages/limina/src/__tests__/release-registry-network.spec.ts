import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createReleaseConsistencyState } from '../package-check/release/consistency/dependencies';
import { loadReleaseRegistryConfiguration } from '../package-check/release/registry/configuration';
import { fetchRegistryPackageMetadata } from '../package-check/release/registry/metadata';
import { fetchRegistryTarball } from '../package-check/release/registry/tarball';

const servers: Server[] = [];
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }),
  );
});

describe('release registry redirect boundary', () => {
  it.each([301, 302, 303, 307, 308])(
    'does not send metadata or tarball requests to a %s redirect target',
    async (status) => {
      let otherOriginHits = 0;
      let sameOriginHits = 0;
      const otherOrigin = await listen(
        createServer((_, response) => {
          otherOriginHits++;
          response.end('{}');
        }),
      );
      let target = `${otherOrigin}/target`;
      const origin = await listen(
        createServer((request, response) => {
          if (request.url === '/target') {
            sameOriginHits++;
            response.end('{}');
            return;
          }
          response.writeHead(status, { location: target });
          response.end();
        }),
      );
      const configuration = loadReleaseRegistryConfiguration(process.cwd(), {
        LIMINA_INTERNAL_TEST_REGISTRY_URL: origin,
      });
      const authority = configuration.authorityFor('pkg');
      for (target of [`${otherOrigin}/target`, `${origin}/target`]) {
        expect(
          await fetchRegistryPackageMetadata(
            'pkg',
            createReleaseConsistencyState(configuration),
            authority,
          ),
        ).toMatchObject({ kind: 'failure', reason: 'request' });
        await expect(
          fetchRegistryTarball(`${origin}/pkg.tgz`, authority),
        ).rejects.toMatchObject({ failure: { kind: 'tarball-request' } });
      }
      expect(otherOriginHits).toBe(0);
      expect(sameOriginHits).toBe(0);
    },
  );
});
