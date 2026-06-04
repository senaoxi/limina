import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertDistArtifacts,
  type ConsumerFixture,
  createConsumerFixture,
  packLiminaDist,
  runNodeScript,
  runPnpm,
} from './helpers';

describe('limina published package smoke', () => {
  it('installs the packed package and exercises the public CLI surface', async () => {
    const manifest = assertDistArtifacts();
    const packedDist = await packLiminaDist();
    let fixture: ConsumerFixture | undefined;

    try {
      fixture = await createConsumerFixture({
        manifest,
        tarballPath: packedDist.tarballPath,
      });

      const helpResult = runPnpm(['exec', 'limina', '--help'], {
        cwd: fixture.fixtureDir,
      });

      expect(helpResult.stdout).toContain('Usage:');
      expect(helpResult.stdout).toContain('$ limina <command> [options]');

      const exportsResult = runNodeScript({
        cwd: fixture.fixtureDir,
        scriptPath: path.join(fixture.fixtureDir, 'verify-exports.mjs'),
      });

      expect(exportsResult.stdout).toContain('limina exports ok');

      const sourceCheckResult = runPnpm(
        [
          'exec',
          'limina',
          '--config',
          './limina.config.mjs',
          'source',
          'check',
        ],
        {
          cwd: fixture.fixtureDir,
        },
      );

      expect(sourceCheckResult.stdout).toContain('limina source check');
      expect(sourceCheckResult.stdout).toContain('limina source passed');
    } finally {
      if (fixture) {
        await fixture.cleanup();
      }
      await packedDist.cleanup();
    }
  });
});
