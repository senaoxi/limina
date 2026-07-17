import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createExplicitMutationAuthority,
  createMechanicalExactMutationAuthority,
  preflightMutationBoundary,
  recheckMutationBoundary,
} from '../utils/mutation-boundary';

async function createFixture(): Promise<{
  cleanup: () => Promise<void>;
  path: (...segments: string[]) => string;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-mutation-boundary-')),
  );
  return {
    cleanup: () => rm(rootDir, { force: true, recursive: true }),
    path: (...segments) => path.join(rootDir, ...segments),
    rootDir,
  };
}

describe('mutation boundary', () => {
  it('allows an explicitly trusted symlink alias while rejecting links below it', async () => {
    const fixture = await createFixture();
    await mkdir(fixture.path('physical'), { recursive: true });
    await symlink(fixture.path('physical'), fixture.path('logical'));
    const authority = await createExplicitMutationAuthority({
      logicalMutationRoot: fixture.path('logical/dist'),
      scope: 'directory',
      trustedBasePath: fixture.path('logical'),
    });

    try {
      await expect(
        preflightMutationBoundary([
          {
            authority,
            kind: 'directory',
            path: fixture.path('logical/dist'),
            recursive: true,
          },
        ]),
      ).resolves.toBeDefined();

      await mkdir(fixture.path('external'), { recursive: true });
      await symlink(fixture.path('external'), fixture.path('physical/dist'));
      await expect(
        preflightMutationBoundary([
          {
            authority,
            kind: 'directory',
            path: fixture.path('logical/dist'),
            recursive: true,
          },
        ]),
      ).rejects.toThrow('symbolic link or junction');
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects nested links during a recursive directory preflight', async () => {
    const fixture = await createFixture();
    const markerPath = fixture.path('external/marker.txt');
    await mkdir(fixture.path('out/nested'), { recursive: true });
    await mkdir(fixture.path('external'), { recursive: true });
    await writeFile(markerPath, 'marker bytes\n');
    await symlink(fixture.path('external'), fixture.path('out/nested/link'));
    const authority = await createExplicitMutationAuthority({
      logicalMutationRoot: fixture.path('out'),
      scope: 'directory',
      trustedBasePath: fixture.rootDir,
    });

    try {
      await expect(
        preflightMutationBoundary([
          {
            authority,
            kind: 'directory',
            path: fixture.path('out'),
            recursive: true,
          },
        ]),
      ).rejects.toThrow('symbolic link or junction');
      await expect(readFile(markerPath, 'utf8')).resolves.toBe(
        'marker bytes\n',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects a final file symlink before mutation', async () => {
    const fixture = await createFixture();
    const markerPath = fixture.path('external-marker.txt');
    const targetPath = fixture.path('out/index.d.ts');
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(markerPath, 'marker bytes\n');
    await symlink(markerPath, targetPath);
    const authority = await createExplicitMutationAuthority({
      logicalMutationRoot: fixture.path('out'),
      scope: 'directory',
      trustedBasePath: fixture.rootDir,
    });

    try {
      await expect(
        preflightMutationBoundary([
          { authority, kind: 'file', path: targetPath },
        ]),
      ).rejects.toThrow('symbolic link or junction');
      await expect(readFile(markerPath, 'utf8')).resolves.toBe(
        'marker bytes\n',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not treat a trusted directory nlink change as identity drift', async () => {
    const fixture = await createFixture();
    const targetPath = fixture.path('missing.txt');
    const authority = await createExplicitMutationAuthority({
      logicalMutationRoot: targetPath,
      scope: 'file',
      trustedBasePath: fixture.rootDir,
    });
    const snapshot = await preflightMutationBoundary([
      { authority, kind: 'file', path: targetPath },
    ]);

    try {
      await mkdir(fixture.path('transaction-created-directory'));
      await expect(recheckMutationBoundary(snapshot)).resolves.toBeUndefined();
      await rm(fixture.path('transaction-created-directory'), {
        recursive: true,
      });
      await expect(recheckMutationBoundary(snapshot)).resolves.toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps regular-file nlink in the stable identity', async () => {
    const fixture = await createFixture();
    const targetPath = fixture.path('target.txt');
    const hardlinkPath = fixture.path('target-hardlink.txt');
    await writeFile(targetPath, 'owned bytes\n');
    const authority = await createExplicitMutationAuthority({
      logicalMutationRoot: targetPath,
      scope: 'file',
      trustedBasePath: fixture.rootDir,
    });
    const snapshot = await preflightMutationBoundary([
      { authority, kind: 'file', path: targetPath },
    ]);

    try {
      await link(targetPath, hardlinkPath);
      await expect(recheckMutationBoundary(snapshot)).rejects.toThrow(
        'drifted after preflight',
      );
      await unlink(hardlinkPath);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not promote a mechanically discovered parent symlink to an anchor', async () => {
    const fixture = await createFixture();
    await mkdir(fixture.path('external'), { recursive: true });
    await symlink(fixture.path('external'), fixture.path('artifacts'));

    try {
      await expect(
        createMechanicalExactMutationAuthority({
          logicalMutationRoot: fixture.path('artifacts/pkg'),
          scope: 'directory',
        }),
      ).rejects.toThrow('symbolic link or junction');
    } finally {
      await fixture.cleanup();
    }
  });

  it.skipIf(process.platform !== 'win32')(
    'rejects a descendant Windows junction',
    async () => {
      const fixture = await createFixture();
      await mkdir(fixture.path('out'), { recursive: true });
      await mkdir(fixture.path('external'), { recursive: true });
      await symlink(
        fixture.path('external'),
        fixture.path('out/junction'),
        'junction',
      );
      const authority = await createExplicitMutationAuthority({
        logicalMutationRoot: fixture.path('out'),
        scope: 'directory',
        trustedBasePath: fixture.rootDir,
      });

      try {
        await expect(
          preflightMutationBoundary([
            {
              authority,
              kind: 'directory',
              path: fixture.path('out'),
              recursive: true,
            },
          ]),
        ).rejects.toThrow('symbolic link or junction');
      } finally {
        await fixture.cleanup();
      }
    },
  );
});
