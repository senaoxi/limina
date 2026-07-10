import type { ResolvedLiminaConfig } from '#config/runner';
import { collectWorkspacePackages } from '#core/workspace/actions';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

async function createFixture(files: Record<string, string>): Promise<{
  cleanup: () => Promise<void>;
  config: ResolvedLiminaConfig;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-workspace-integration-')),
  );

  for (const [relativePath, text] of Object.entries(files)) {
    await writeText(path.join(rootDir, relativePath), text);
  }

  return {
    cleanup: async () => {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    },
    config: {
      configPath: path.join(rootDir, 'limina.config.mjs'),
      rootDir,
    },
    rootDir,
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
      await expect(collectWorkspacePackages(fixture.config)).resolves.toEqual(
        [],
      );
    } finally {
      await fixture.cleanup();
    }
  });
});
