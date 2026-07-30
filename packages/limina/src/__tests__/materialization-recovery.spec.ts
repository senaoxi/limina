import { execFile, spawn } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  getMaterializationMarkerPath,
  readMaterializationStateSnapshot,
} from '../core/build-graph/materialization-state';
import {
  materializeGeneratedArtifactPlan,
  withGeneratedArtifactReadLease,
} from '../core/build-graph/materializer';
import {
  createLiminaArtifactNamespace,
  type LiminaArtifactNamespace,
} from '../domain/artifacts/namespace';
import {
  type ArtifactChange,
  type ArtifactPlan,
  createRevisionedArtifactPlan,
} from '../domain/artifacts/plan';
import {
  acquireCrossProcessReadLease,
  acquireCrossProcessWriteLease,
} from '../utils/mutation/cross-process-lease';

const execFileAsync = promisify(execFile);

async function createFixture(): Promise<{
  cleanup(): Promise<void>;
  namespace: LiminaArtifactNamespace;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-materialization-recovery-')),
  );
  await writeFile(
    path.join(rootDir, 'package.json'),
    '{"name":"fixture","private":true}\n',
  );
  return {
    cleanup: () => rm(rootDir, { force: true, recursive: true }),
    namespace: createLiminaArtifactNamespace({ generation: 0, rootDir }),
    rootDir,
  };
}

function manifestContent(ownedArtifacts: string[]): string {
  return `${JSON.stringify(
    {
      version: 3,
      generatedBy: 'limina',
      checkers: {},
      knip: { diagnostics: [], packages: [] },
      ownedArtifacts,
      providerEdges: [],
    },
    null,
    2,
  )}\n`;
}

async function createCompletePlan(options: {
  content: string;
  namespace: LiminaArtifactNamespace;
}): Promise<ArtifactPlan> {
  const generatedPath = path.join(options.namespace.rootDir, 'generated.json');
  const manifestPath = path.join(options.namespace.rootDir, 'manifest.json');
  const base = await readMaterializationStateSnapshot(options.namespace);
  const changes: ArtifactChange[] = [
    {
      artifact: {
        content: options.content,
        kind: 'generated-config',
        origin: { domain: 'test' },
        path: generatedPath,
      },
      status: 'update',
    },
    {
      artifact: {
        content: manifestContent(['generated.json', 'manifest.json']),
        kind: 'generated-manifest',
        origin: { domain: 'test' },
        path: manifestPath,
      },
      status: 'update',
    },
  ];
  return createRevisionedArtifactPlan(options.namespace, changes, {
    baseOwnedPaths: base.ownedPaths.map((relativePath) =>
      path.join(options.namespace.rootDir, relativePath),
    ),
    baseRevision: base.revision,
    ownedPaths: [generatedPath, manifestPath],
  });
}

async function createArtifactSetPlan(options: {
  artifacts: Readonly<Record<string, string>>;
  namespace: LiminaArtifactNamespace;
}): Promise<ArtifactPlan> {
  const base = await readMaterializationStateSnapshot(options.namespace);
  const ownedArtifacts = [
    ...Object.keys(options.artifacts),
    'manifest.json',
  ].sort();
  const changes: ArtifactChange[] = [
    ...Object.entries(options.artifacts).map(
      ([relativePath, content]): ArtifactChange => ({
        artifact: {
          content,
          kind: 'generated-config',
          origin: { domain: 'test' },
          path: path.join(options.namespace.rootDir, relativePath),
        },
        status: 'update',
      }),
    ),
    {
      artifact: {
        content: manifestContent(ownedArtifacts),
        kind: 'generated-manifest',
        origin: { domain: 'test' },
        path: path.join(options.namespace.rootDir, 'manifest.json'),
      },
      status: 'update',
    },
  ];
  return createRevisionedArtifactPlan(options.namespace, changes, {
    baseOwnedPaths: base.ownedPaths.map((relativePath) =>
      path.join(options.namespace.rootDir, relativePath),
    ),
    baseRevision: base.revision,
    ownedPaths: ownedArtifacts.map((relativePath) =>
      path.join(options.namespace.rootDir, relativePath),
    ),
  });
}

describe('generated artifact materialization recovery', () => {
  it('publishes the marker before mutation, fails readers closed, and fully rematerializes on the next writer', async () => {
    const fixture = await createFixture();
    const firstPlan = await createCompletePlan({
      content: 'first\n',
      namespace: fixture.namespace,
    });
    try {
      await expect(
        materializeGeneratedArtifactPlan(fixture.namespace, firstPlan, {
          async beforeMutation() {
            await expect(
              readFile(getMaterializationMarkerPath(fixture.namespace), 'utf8'),
            ).resolves.toContain('"version": 1');
            throw new Error('simulated writer crash');
          },
        }),
      ).rejects.toThrow('simulated writer crash');

      await expect(
        withGeneratedArtifactReadLease(fixture.namespace, async () => true),
      ).rejects.toThrow('writer must recover');

      let replans = 0;
      const optimistic = await createCompletePlan({
        content: 'stale optimistic\n',
        namespace: fixture.namespace,
      });
      await materializeGeneratedArtifactPlan(fixture.namespace, optimistic, {
        replan: async () => {
          replans += 1;
          return {
            namespace: fixture.namespace,
            plan: await createCompletePlan({
              content: 'recovered\n',
              namespace: fixture.namespace,
            }),
          };
        },
      });

      expect(replans).toBe(1);
      await expect(
        readFile(
          path.join(fixture.namespace.rootDir, 'generated.json'),
          'utf8',
        ),
      ).resolves.toBe('recovered\n');
      await expect(
        readFile(getMaterializationMarkerPath(fixture.namespace), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fixture.cleanup();
    }
  });

  it('replans at most once under the writer lease and fails before mutation on a second drift', async () => {
    const fixture = await createFixture();
    try {
      const optimistic = await createCompletePlan({
        content: 'optimistic\n',
        namespace: fixture.namespace,
      });
      await mkdir(fixture.namespace.rootDir, { recursive: true });
      await writeFile(
        path.join(fixture.namespace.rootDir, 'current.json'),
        'current\n',
      );
      await writeFile(
        path.join(fixture.namespace.rootDir, 'manifest.json'),
        manifestContent(['current.json', 'manifest.json']),
      );
      const replan = vi.fn(async () => {
        const fresh = await createCompletePlan({
          content: 'fresh\n',
          namespace: fixture.namespace,
        });
        await writeFile(
          path.join(fixture.namespace.rootDir, 'current.json'),
          'drifted again\n',
        );
        return { namespace: fixture.namespace, plan: fresh };
      });

      await expect(
        materializeGeneratedArtifactPlan(fixture.namespace, optimistic, {
          replan,
        }),
      ).rejects.toThrow('single allowed replan');
      expect(replan).toHaveBeenCalledTimes(1);
      await expect(
        readFile(getMaterializationMarkerPath(fixture.namespace), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fixture.cleanup();
    }
  });

  it('expands the recovery ownership universe and removes crash-only and obsolete files', async () => {
    const fixture = await createFixture();
    try {
      await materializeGeneratedArtifactPlan(
        fixture.namespace,
        await createArtifactSetPlan({
          artifacts: { 'obsolete.json': 'obsolete\n' },
          namespace: fixture.namespace,
        }),
      );
      let mutationCount = 0;
      await expect(
        materializeGeneratedArtifactPlan(
          fixture.namespace,
          await createArtifactSetPlan({
            artifacts: { 'crash-only.json': 'crash\n' },
            namespace: fixture.namespace,
          }),
          {
            beforeMutation() {
              mutationCount += 1;
              if (mutationCount === 2) throw new Error('crash after write');
            },
          },
        ),
      ).rejects.toThrow('crash after write');

      const optimistic = await createArtifactSetPlan({
        artifacts: { 'stale.json': 'stale\n' },
        namespace: fixture.namespace,
      });
      await materializeGeneratedArtifactPlan(fixture.namespace, optimistic, {
        replan: async () => ({
          namespace: fixture.namespace,
          plan: await createArtifactSetPlan({
            artifacts: { 'fresh.json': 'fresh\n' },
            namespace: fixture.namespace,
          }),
        }),
      });

      await expect(
        readFile(path.join(fixture.namespace.rootDir, 'fresh.json'), 'utf8'),
      ).resolves.toBe('fresh\n');
      for (const removed of [
        'crash-only.json',
        'obsolete.json',
        'stale.json',
      ]) {
        await expect(
          access(path.join(fixture.namespace.rootDir, removed)),
        ).rejects.toMatchObject({ code: 'ENOENT' });
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('fails closed for a corrupt marker and treats marker cleanup failure as materialization failure', async () => {
    const fixture = await createFixture();
    try {
      const markerPath = getMaterializationMarkerPath(fixture.namespace);
      await mkdir(path.dirname(markerPath), { recursive: true });
      await writeFile(markerPath, '{broken\n');
      const plan = await createCompletePlan({
        content: 'content\n',
        namespace: fixture.namespace,
      });
      await expect(
        withGeneratedArtifactReadLease(fixture.namespace, async () => true),
      ).rejects.toThrow('recovery marker is corrupt');
      await expect(
        materializeGeneratedArtifactPlan(fixture.namespace, plan),
      ).rejects.toThrow('recovery marker is corrupt');

      await rm(markerPath);
      await expect(
        materializeGeneratedArtifactPlan(fixture.namespace, plan, {
          removeMarker: async () => {
            throw new Error('marker cleanup failed');
          },
        }),
      ).rejects.toThrow('marker cleanup failed');
      await expect(readFile(markerPath, 'utf8')).resolves.toContain(
        '"version": 1',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses one canonical lease for lexical root aliases and gives writers priority over new readers', async () => {
    const fixture = await createFixture();
    const aliasRoot = `${fixture.rootDir}-alias`;
    await symlink(
      fixture.rootDir,
      aliasRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const aliasNamespace = createLiminaArtifactNamespace({
      generation: 0,
      rootDir: aliasRoot,
    });
    const writer = await acquireCrossProcessWriteLease(
      fixture.namespace.canonicalRootDir,
    );
    try {
      expect(aliasNamespace.canonicalRootDir).toBe(
        fixture.namespace.canonicalRootDir,
      );
      await expect(
        acquireCrossProcessReadLease(aliasNamespace.canonicalRootDir, {
          timeoutMs: 25,
        }),
      ).rejects.toThrow('generated-artifact read lease');
    } finally {
      await writer.release();
      await rm(aliasRoot, { force: true });
      await fixture.cleanup();
    }
  });

  it('releases a published writer holder when existing readers outlive the bounded wait', async () => {
    const fixture = await createFixture();
    const reader = await acquireCrossProcessReadLease(
      fixture.namespace.canonicalRootDir,
    );
    try {
      await expect(
        acquireCrossProcessWriteLease(fixture.namespace.canonicalRootDir, {
          timeoutMs: 25,
        }),
      ).rejects.toThrow('readers to exit');
    } finally {
      await reader.release();
    }
    const writer = await acquireCrossProcessWriteLease(
      fixture.namespace.canonicalRootDir,
      { timeoutMs: 100 },
    );
    await writer.release();
    await fixture.cleanup();
  });

  it('coordinates independent Node processes through the canonical lease', async () => {
    const fixture = await createFixture();
    const readyPath = path.join(fixture.rootDir, 'writer-ready');
    const releasePath = path.join(fixture.rootDir, 'writer-release');
    const leaseModule = fileURLToPath(
      new URL('../utils/mutation/cross-process-lease.ts', import.meta.url),
    );
    const writerScript = `
      import { existsSync } from 'node:fs';
      import { writeFile } from 'node:fs/promises';
      const { acquireCrossProcessWriteLease } = await import(${JSON.stringify(leaseModule)});
      const lease = await acquireCrossProcessWriteLease(process.env.LEASE_ROOT);
      await writeFile(process.env.READY_PATH, 'ready\\n');
      while (!existsSync(process.env.RELEASE_PATH)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await lease.release();
    `;
    const readerScript = `
      const { acquireCrossProcessReadLease } = await import(${JSON.stringify(leaseModule)});
      try {
        const lease = await acquireCrossProcessReadLease(process.env.LEASE_ROOT, { timeoutMs: 75 });
        await lease.release();
        console.log('unexpected-acquire');
      } catch (error) {
        console.log(error.name);
      }
    `;
    const writer = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', writerScript],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LEASE_ROOT: fixture.namespace.canonicalRootDir,
          READY_PATH: readyPath,
          RELEASE_PATH: releasePath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const writerExitPromise = new Promise<number | null>((resolve) => {
      writer.once('exit', resolve);
    });

    try {
      await vi.waitFor(
        async () => {
          await expect(access(readyPath)).resolves.toBeUndefined();
        },
        { timeout: 5000 },
      );
      const reader = await execFileAsync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', readerScript],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            LEASE_ROOT: fixture.namespace.canonicalRootDir,
          },
        },
      );
      expect(reader.stdout).toContain('CrossProcessLeaseTimeoutError');
    } finally {
      await writeFile(releasePath, 'release\n');
      const writerExit = await writerExitPromise;
      expect(writerExit).toBe(0);
      await fixture.cleanup();
    }
  });
});
