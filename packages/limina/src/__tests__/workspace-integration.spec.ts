import type { ResolvedLiminaConfig } from '#config/runner';
import { collectWorkspacePackages } from '#core/workspace/actions';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withFixtureGovernanceRoot } from './helpers/governance-root';

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

async function createFixture(files: Record<string, string>): Promise<{
  cleanup: () => Promise<void>;
  config: ResolvedLiminaConfig;
  rootDir: string;
}> {
  const rootDirectoryTemporaryPath = await mkdtemp(
    path.join(tmpdir(), 'limina-workspace-integration-'),
  );
  const rootDirectory = await realpath(rootDirectoryTemporaryPath);

  await writeText(path.join(rootDirectory, 'package.json'), '{}');
  for (const [relativePath, text] of Object.entries(files)) {
    await writeText(path.join(rootDirectory, relativePath), text);
  }

  return {
    cleanup: async () => {
      await rm(rootDirectory, {
        force: true,
        recursive: true,
      });
    },
    config: withFixtureGovernanceRoot({
      configPath: path.join(rootDirectory, 'limina.config.mjs'),
      rootDir: rootDirectory,
    }),
    rootDir: rootDirectory,
  };
}

describe('collectWorkspacePackages pnpm integration', () => {
  it('does not apply pnpm CLI failIfNoMatch semantics during enumeration', async () => {
    const fixture = await createFixture({
      'pnpm-workspace.yaml': [
        'packages:',
        '  - packages/*',
        'failIfNoMatch: true',
        '',
      ].join('\n'),
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
    });

    try {
      await expect(
        collectWorkspacePackages(fixture.config),
      ).resolves.toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });
});
