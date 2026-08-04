import { type ChildProcess, execFile, spawn } from 'node:child_process';
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
  resolveArtifactNamespaceRelativePath,
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

function createMaterializerChildScript(body: string): string {
  const materializerModule = new URL(
    '../core/build-graph/materializer.ts',
    import.meta.url,
  ).href;
  const namespaceModule = new URL(
    '../domain/artifacts/namespace.ts',
    import.meta.url,
  ).href;
  const planModule = new URL('../domain/artifacts/plan.ts', import.meta.url)
    .href;
  const stateModule = new URL(
    '../core/build-graph/materialization-state.ts',
    import.meta.url,
  ).href;
  return `
    import { writeFile } from 'node:fs/promises';
    const { materializeGeneratedArtifactPlan } = await import(${JSON.stringify(materializerModule)});
    const {
      createLiminaArtifactNamespace,
      resolveArtifactNamespaceRelativePath,
    } = await import(${JSON.stringify(namespaceModule)});
    const { createRevisionedArtifactPlan } = await import(${JSON.stringify(planModule)});
    const { readMaterializationStateSnapshot } = await import(${JSON.stringify(stateModule)});
    const namespace = createLiminaArtifactNamespace({
      generation: Number(process.env.GENERATION ?? '0'),
      rootDir: process.env.ROOT_DIR,
    });
    const manifestContent = (ownedArtifacts) =>
      JSON.stringify({
        version: 3,
        generatedBy: 'limina',
        checkers: {},
        knip: { diagnostics: [], packages: [] },
        ownedArtifacts,
        providerEdges: [],
      }, null, 2) + '\\n';
    const createPlan = async (artifacts) => {
      const base = await readMaterializationStateSnapshot(namespace);
      const ownedArtifacts = [...Object.keys(artifacts), 'manifest.json'].sort();
      const changes = [
        ...Object.entries(artifacts).map(([relativePath, content]) => ({
          artifact: {
            content,
            kind: 'generated-config',
            origin: { domain: 'child-test' },
            path: resolveArtifactNamespaceRelativePath(namespace, relativePath),
          },
          status: 'update',
        })),
        {
          artifact: {
            content: manifestContent(ownedArtifacts),
            kind: 'generated-manifest',
            origin: { domain: 'child-test' },
            path: resolveArtifactNamespaceRelativePath(namespace, 'manifest.json'),
          },
          status: 'update',
        },
      ];
      return createRevisionedArtifactPlan(namespace, changes, {
        baseOwnedPaths: base.ownedPaths.map((relativePath) =>
          resolveArtifactNamespaceRelativePath(namespace, relativePath)
        ),
        baseRevision: base.revision,
        ownedPaths: ownedArtifacts.map((relativePath) =>
          resolveArtifactNamespaceRelativePath(namespace, relativePath)
        ),
      });
    };
    ${body}
  `;
}

interface ChildResult {
  code: number | null;
  stderr: string;
  stdout: string;
}

function collectChildResult(child: ChildProcess): Promise<ChildResult> {
  let stderr = '';
  let stdout = '';
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  child.stdout?.on('data', (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });
  return new Promise((resolve) => {
    child.once('close', (code) => resolve({ code, stderr, stdout }));
  });
}

function expectChildSuccess(result: ChildResult): void {
  const diagnostics = [result.stderr, result.stdout]
    .filter((output) => output.length > 0)
    .join('\n');
  expect(
    result.code,
    diagnostics.length > 0
      ? `Child process output:\n${diagnostics}`
      : 'Child process exited without diagnostics',
  ).toBe(0);
}

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
  const generatedPath = resolveArtifactNamespaceRelativePath(
    options.namespace,
    'generated.json',
  );
  const manifestPath = resolveArtifactNamespaceRelativePath(
    options.namespace,
    'manifest.json',
  );
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
      resolveArtifactNamespaceRelativePath(options.namespace, relativePath),
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
          path: resolveArtifactNamespaceRelativePath(
            options.namespace,
            relativePath,
          ),
        },
        status: 'update',
      }),
    ),
    {
      artifact: {
        content: manifestContent(ownedArtifacts),
        kind: 'generated-manifest',
        origin: { domain: 'test' },
        path: resolveArtifactNamespaceRelativePath(
          options.namespace,
          'manifest.json',
        ),
      },
      status: 'update',
    },
  ];
  return createRevisionedArtifactPlan(options.namespace, changes, {
    baseOwnedPaths: base.ownedPaths.map((relativePath) =>
      resolveArtifactNamespaceRelativePath(options.namespace, relativePath),
    ),
    baseRevision: base.revision,
    ownedPaths: ownedArtifacts.map((relativePath) =>
      resolveArtifactNamespaceRelativePath(options.namespace, relativePath),
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
    const leaseModule = new URL(
      '../utils/mutation/cross-process-lease.ts',
      import.meta.url,
    ).href;
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

  it('replans a different desired tree in a second independent materializer', async () => {
    const fixture = await createFixture();
    const writerReady = path.join(fixture.rootDir, 'writer-a-ready');
    const contenderReady = path.join(fixture.rootDir, 'writer-b-ready');
    const writerScript = createMaterializerChildScript(`
      const plan = await createPlan({ 'a-only.json': 'writer-a\\n' });
      let paused = false;
      await materializeGeneratedArtifactPlan(namespace, plan, {
        async beforeMutation() {
          if (paused) return;
          paused = true;
          await writeFile(process.env.READY_PATH, 'ready\\n');
          await new Promise((resolve) => process.stdin.once('data', resolve));
        },
      });
    `);
    const contenderScript = createMaterializerChildScript(`
      const artifacts = { 'b-only.json': 'writer-b\\n' };
      const optimistic = await createPlan(artifacts);
      await writeFile(process.env.READY_PATH, 'ready\\n');
      let replans = 0;
      await materializeGeneratedArtifactPlan(namespace, optimistic, {
        replan: async () => {
          replans += 1;
          return { namespace, plan: await createPlan(artifacts) };
        },
      });
      console.log(JSON.stringify({ replans }));
    `);
    const childOptions = {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
    };
    const writer = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', writerScript],
      {
        ...childOptions,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GENERATION: '1',
          READY_PATH: writerReady,
          ROOT_DIR: fixture.rootDir,
        },
      },
    );
    const writerResult = collectChildResult(writer);
    let contender: ChildProcess | undefined;

    try {
      await vi.waitFor(
        () => expect(access(writerReady)).resolves.toBeUndefined(),
        {
          timeout: 5000,
        },
      );
      const contenderChild = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', contenderScript],
        {
          ...childOptions,
          env: {
            ...process.env,
            GENERATION: '2',
            READY_PATH: contenderReady,
            ROOT_DIR: fixture.rootDir,
          },
        },
      );
      contender = contenderChild;
      const contenderResult = collectChildResult(contenderChild);
      await vi.waitFor(
        () => expect(access(contenderReady)).resolves.toBeUndefined(),
        { timeout: 5000 },
      );
      writer.stdin?.end('release\n');

      expectChildSuccess(await writerResult);
      const second = await contenderResult;
      expectChildSuccess(second);
      expect(JSON.parse(second.stdout)).toEqual({ replans: 1 });
      await expect(
        readFile(path.join(fixture.namespace.rootDir, 'b-only.json'), 'utf8'),
      ).resolves.toBe('writer-b\n');
      await expect(
        access(path.join(fixture.namespace.rootDir, 'a-only.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        readFile(path.join(fixture.namespace.rootDir, 'manifest.json'), 'utf8'),
      ).resolves.toContain('b-only.json');
    } finally {
      if (writer.stdin !== null && !writer.stdin.writableEnded) {
        writer.stdin.end('release\n');
      }
      writer.kill('SIGKILL');
      contender?.kill('SIGKILL');
      await fixture.cleanup();
    }
  }, 20_000);

  it('lets a fresh independent writer recover after a materializer process is killed', async () => {
    const fixture = await createFixture();
    const crashReady = path.join(fixture.rootDir, 'crash-ready');
    await materializeGeneratedArtifactPlan(
      fixture.namespace,
      await createArtifactSetPlan({
        artifacts: { 'obsolete.json': 'obsolete\n' },
        namespace: fixture.namespace,
      }),
    );
    const crashScript = createMaterializerChildScript(`
      const plan = await createPlan({ 'crash-only.json': 'crash\\n' });
      let mutations = 0;
      await materializeGeneratedArtifactPlan(namespace, plan, {
        async beforeMutation() {
          mutations += 1;
          if (mutations !== 2) return;
          await writeFile(process.env.READY_PATH, 'ready\\n');
          await new Promise(() => {});
        },
      });
    `);
    const recoveryScript = createMaterializerChildScript(`
      const artifacts = { 'fresh.json': 'fresh\\n' };
      const optimistic = await createPlan(artifacts);
      let replans = 0;
      await materializeGeneratedArtifactPlan(namespace, optimistic, {
        replan: async () => {
          replans += 1;
          return { namespace, plan: await createPlan(artifacts) };
        },
      });
      console.log(JSON.stringify({ replans }));
    `);
    const crashed = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', crashScript],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          GENERATION: '3',
          READY_PATH: crashReady,
          ROOT_DIR: fixture.rootDir,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const crashedResult = collectChildResult(crashed);

    try {
      await vi.waitFor(
        () => expect(access(crashReady)).resolves.toBeUndefined(),
        {
          timeout: 5000,
        },
      );
      crashed.kill('SIGKILL');
      await expect(crashedResult).resolves.not.toMatchObject({ code: 0 });
      await expect(
        access(path.join(fixture.namespace.rootDir, 'crash-only.json')),
      ).resolves.toBeUndefined();
      await expect(
        access(getMaterializationMarkerPath(fixture.namespace)),
      ).resolves.toBeUndefined();

      const recovered = await execFileAsync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', recoveryScript],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            GENERATION: '4',
            ROOT_DIR: fixture.rootDir,
          },
        },
      );
      expect(JSON.parse(recovered.stdout)).toEqual({ replans: 1 });
      await expect(
        readFile(path.join(fixture.namespace.rootDir, 'fresh.json'), 'utf8'),
      ).resolves.toBe('fresh\n');
      for (const removed of ['crash-only.json', 'obsolete.json']) {
        await expect(
          access(path.join(fixture.namespace.rootDir, removed)),
        ).rejects.toMatchObject({ code: 'ENOENT' });
      }
      await expect(
        access(getMaterializationMarkerPath(fixture.namespace)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        withGeneratedArtifactReadLease(fixture.namespace, async () => true),
      ).resolves.toBe(true);
    } finally {
      crashed.kill('SIGKILL');
      await fixture.cleanup();
    }
  }, 20_000);
});
