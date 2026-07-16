import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getGeneratedDtsConfigPath,
  getGeneratedOutDir,
  getGeneratedOutputProjectConfigPath,
  getGeneratedOutputSolutionConfigPath,
  getGeneratedOutputTsBuildInfoPath,
  getGeneratedSolutionBuildConfigPath,
  getGeneratedTsBuildInfoPath,
} from '../core/build-graph/generated/paths';
import { materializeGeneratedArtifactPlan } from '../core/build-graph/materializer';
import {
  ArtifactNamespaceContainmentError,
  createLiminaArtifactNamespace,
} from '../domain/artifacts/namespace';
import {
  type ArtifactChange,
  type ArtifactPlan,
  createArtifactPlan,
} from '../domain/artifacts/plan';
import { createProfilingMetricsRecorder } from '../profiling/metrics';
import { createFixturePathResolver } from './helpers/path';

async function createFixture(): Promise<{
  cleanup: () => Promise<void>;
  path: (...segments: string[]) => string;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-artifact-namespace-')),
  );
  return {
    cleanup: () => rm(rootDir, { force: true, recursive: true }),
    path: createFixturePathResolver(rootDir),
    rootDir,
  };
}

function createChange(
  filePath: string,
  content = 'generated\n',
): Exclude<ArtifactChange, { status: 'delete' }> {
  return {
    artifact: {
      content,
      kind: 'generated-config',
      origin: { domain: 'test' },
      path: filePath,
    },
    status: 'create',
  };
}

function createUnchangedChange(
  filePath: string,
  content = 'generated\n',
): Extract<ArtifactChange, { status: 'unchanged' }> {
  return {
    artifact: {
      content,
      kind: 'generated-config',
      origin: { domain: 'test' },
      path: filePath,
    },
    status: 'unchanged',
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe('trusted artifact namespace', () => {
  it('maps every external generated path through external/<stable-id> without dot-dot segments', async () => {
    const fixture = await createFixture();
    const externalRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-external-package-')),
    );
    const sourceConfigPath = path.join(
      externalRoot,
      'configs/tsconfig.lib.json',
    );
    await mkdir(path.dirname(sourceConfigPath), { recursive: true });
    await writeFile(sourceConfigPath, '{}\n');
    const sharedOptions = {
      checkerName: 'typescript',
      packageRootDir: externalRoot,
      rootDir: fixture.rootDir,
      sourceConfigPath,
    };
    const generatedPaths = [
      getGeneratedDtsConfigPath(sharedOptions),
      getGeneratedOutDir(sharedOptions),
      getGeneratedOutputProjectConfigPath(sharedOptions),
      getGeneratedOutputSolutionConfigPath(sharedOptions),
      getGeneratedOutputTsBuildInfoPath(sharedOptions),
      getGeneratedSolutionBuildConfigPath(sharedOptions),
      getGeneratedTsBuildInfoPath(sharedOptions),
    ];

    try {
      for (const generatedPath of generatedPaths) {
        const relativePath = path.relative(
          fixture.path('.limina'),
          generatedPath,
        );
        expect(relativePath.split(path.sep)).not.toContain('..');
        expect(relativePath.replaceAll(path.sep, '/')).toMatch(
          /(?:^|\/)external\/[a-f0-9]{64}(?:\/|$)/u,
        );
      }
      expect(new Set(generatedPaths).size).toBe(generatedPaths.length);
    } finally {
      await Promise.all([
        fixture.cleanup(),
        rm(externalRoot, { force: true, recursive: true }),
      ]);
    }
  });

  it('rejects an external source config outside its activated package root', async () => {
    const fixture = await createFixture();
    const externalRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-external-package-')),
    );
    const outsideRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-external-outside-')),
    );

    try {
      expect(() =>
        getGeneratedDtsConfigPath({
          checkerName: 'typescript',
          packageRootDir: externalRoot,
          rootDir: fixture.rootDir,
          sourceConfigPath: path.join(outsideRoot, 'tsconfig.json'),
        }),
      ).toThrow(/outside its activated package root/u);
    } finally {
      await Promise.all([
        fixture.cleanup(),
        rm(externalRoot, { force: true, recursive: true }),
        rm(outsideRoot, { force: true, recursive: true }),
      ]);
    }
  });

  it('rejects lexical escapes while planning', async () => {
    const fixture = await createFixture();
    const namespace = createLiminaArtifactNamespace({
      generation: 0,
      rootDir: fixture.rootDir,
    });

    try {
      expect(() =>
        createArtifactPlan(
          namespace,
          [createChange(fixture.path('outside.json'))],
          [],
        ),
      ).toThrow(ArtifactNamespaceContainmentError);
      expect(() =>
        createArtifactPlan(namespace, [], [fixture.path('outside.json')]),
      ).toThrow(ArtifactNamespaceContainmentError);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects stale generation plans before creating a file', async () => {
    const fixture = await createFixture();
    const generationZero = createLiminaArtifactNamespace({
      generation: 0,
      rootDir: fixture.rootDir,
    });
    const generationOne = createLiminaArtifactNamespace({
      generation: 1,
      rootDir: fixture.rootDir,
    });
    const targetPath = fixture.path('.limina/generated.json');
    const plan = createArtifactPlan(
      generationZero,
      [createChange(targetPath)],
      [targetPath],
    );

    try {
      await expect(
        materializeGeneratedArtifactPlan(generationOne, plan),
      ).rejects.toThrow(/different preflight generation/u);
      await expect(fileExists(targetPath)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects a forged plan even when it copies an authentic generation token', async () => {
    const fixture = await createFixture();
    const namespace = createLiminaArtifactNamespace({
      generation: 0,
      rootDir: fixture.rootDir,
    });
    const targetPath = fixture.path('.limina/generated.json');
    const authentic = createArtifactPlan(
      namespace,
      [createChange(targetPath)],
      [targetPath],
    );
    const forged = { ...authentic } as ArtifactPlan;

    try {
      await expect(
        materializeGeneratedArtifactPlan(namespace, forged),
      ).rejects.toThrow(/Unauthenticated generated artifact plan/u);
      await expect(fileExists(targetPath)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects a symlinked .limina root without touching its destination', async () => {
    const fixture = await createFixture();
    const externalRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-artifact-destination-')),
    );
    const namespace = createLiminaArtifactNamespace({
      generation: 0,
      rootDir: fixture.rootDir,
    });
    const targetPath = fixture.path('.limina/generated.json');
    await symlink(externalRoot, namespace.rootDir, 'dir');
    const plan = createArtifactPlan(
      namespace,
      [createChange(targetPath)],
      [targetPath],
    );

    try {
      await expect(
        materializeGeneratedArtifactPlan(namespace, plan),
      ).rejects.toThrow(/crosses a symbolic link/u);
      await expect(
        fileExists(path.join(externalRoot, 'generated.json')),
      ).resolves.toBe(false);
    } finally {
      await Promise.all([
        fixture.cleanup(),
        rm(externalRoot, { force: true, recursive: true }),
      ]);
    }
  });

  it('rejects an intermediate directory symlink before any plan mutation', async () => {
    const fixture = await createFixture();
    const externalRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-artifact-destination-')),
    );
    const namespace = createLiminaArtifactNamespace({
      generation: 0,
      rootDir: fixture.rootDir,
    });
    const safePath = fixture.path('.limina/a-safe.json');
    const unsafePath = fixture.path('.limina/z-linked/generated.json');
    await mkdir(namespace.rootDir, { recursive: true });
    await symlink(externalRoot, fixture.path('.limina/z-linked'), 'dir');
    const plan = createArtifactPlan(
      namespace,
      [createChange(safePath), createChange(unsafePath)],
      [safePath, unsafePath],
    );

    try {
      await expect(
        materializeGeneratedArtifactPlan(namespace, plan),
      ).rejects.toThrow(/crosses a symbolic link/u);
      await expect(fileExists(safePath)).resolves.toBe(false);
      await expect(
        fileExists(path.join(externalRoot, 'generated.json')),
      ).resolves.toBe(false);
    } finally {
      await Promise.all([
        fixture.cleanup(),
        rm(externalRoot, { force: true, recursive: true }),
      ]);
    }
  });

  it('rejects existing symlink and non-file targets for create, update, and delete', async () => {
    const fixture = await createFixture();
    const externalPath = fixture.path('external.json');
    const namespace = createLiminaArtifactNamespace({
      generation: 0,
      rootDir: fixture.rootDir,
    });
    const linkedTarget = fixture.path('.limina/linked.json');
    const directoryTarget = fixture.path('.limina/directory.json');
    await mkdir(namespace.rootDir, { recursive: true });
    await writeFile(externalPath, 'external\n');
    await symlink(externalPath, linkedTarget);
    await mkdir(directoryTarget);

    try {
      for (const plan of [
        createArtifactPlan(
          namespace,
          [
            {
              artifact: {
                ...createChange(linkedTarget).artifact,
                content: 'updated\n',
              },
              status: 'update',
            },
          ],
          [linkedTarget],
        ),
        createArtifactPlan(
          namespace,
          [{ path: linkedTarget, status: 'delete' }],
          [],
        ),
        createArtifactPlan(
          namespace,
          [createChange(directoryTarget)],
          [directoryTarget],
        ),
      ]) {
        await expect(
          materializeGeneratedArtifactPlan(namespace, plan),
        ).rejects.toThrow(ArtifactNamespaceContainmentError);
      }
      expect(await readFile(externalPath, 'utf8')).toBe('external\n');
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects a symlinked .limina root for an all-unchanged plan', async () => {
    const fixture = await createFixture();
    const externalRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-artifact-destination-')),
    );
    const namespace = createLiminaArtifactNamespace({
      generation: 0,
      rootDir: fixture.rootDir,
    });
    const targetPath = fixture.path('.limina/generated.json');
    await writeFile(path.join(externalRoot, 'generated.json'), 'generated\n');
    await symlink(externalRoot, namespace.rootDir, 'dir');
    const plan = createArtifactPlan(
      namespace,
      [createUnchangedChange(targetPath)],
      [targetPath],
    );

    try {
      await expect(
        materializeGeneratedArtifactPlan(namespace, plan),
      ).rejects.toThrow(/crosses a symbolic link/u);
      expect(
        await readFile(path.join(externalRoot, 'generated.json'), 'utf8'),
      ).toBe('generated\n');
    } finally {
      await Promise.all([
        fixture.cleanup(),
        rm(externalRoot, { force: true, recursive: true }),
      ]);
    }
  });

  it('rejects a symlinked intermediate directory for an all-unchanged plan', async () => {
    const fixture = await createFixture();
    const externalRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-artifact-destination-')),
    );
    const namespace = createLiminaArtifactNamespace({
      generation: 0,
      rootDir: fixture.rootDir,
    });
    const targetPath = fixture.path('.limina/configs/generated.json');
    await mkdir(namespace.rootDir, { recursive: true });
    await writeFile(path.join(externalRoot, 'generated.json'), 'generated\n');
    await symlink(externalRoot, fixture.path('.limina/configs'), 'dir');
    const plan = createArtifactPlan(
      namespace,
      [createUnchangedChange(targetPath)],
      [targetPath],
    );

    try {
      await expect(
        materializeGeneratedArtifactPlan(namespace, plan),
      ).rejects.toThrow(/crosses a symbolic link/u);
    } finally {
      await Promise.all([
        fixture.cleanup(),
        rm(externalRoot, { force: true, recursive: true }),
      ]);
    }
  });

  it('rejects an unchanged target that is itself a symlink', async () => {
    const fixture = await createFixture();
    const namespace = createLiminaArtifactNamespace({
      generation: 0,
      rootDir: fixture.rootDir,
    });
    const externalPath = fixture.path('external.json');
    const targetPath = fixture.path('.limina/generated.json');
    await mkdir(namespace.rootDir, { recursive: true });
    await writeFile(externalPath, 'generated\n');
    await symlink(externalPath, targetPath);
    const plan = createArtifactPlan(
      namespace,
      [createUnchangedChange(targetPath)],
      [targetPath],
    );

    try {
      await expect(
        materializeGeneratedArtifactPlan(namespace, plan),
      ).rejects.toThrow(/crosses a symbolic link/u);
      expect(await readFile(externalPath, 'utf8')).toBe('generated\n');
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects an unsafe unchanged target in a mixed plan before any mutation', async () => {
    const fixture = await createFixture();
    const namespace = createLiminaArtifactNamespace({
      generation: 0,
      rootDir: fixture.rootDir,
    });
    const externalPath = fixture.path('external.json');
    const safePath = fixture.path('.limina/a-safe.json');
    const unsafePath = fixture.path('.limina/z-unsafe.json');
    await mkdir(namespace.rootDir, { recursive: true });
    await writeFile(externalPath, 'generated\n');
    await symlink(externalPath, unsafePath);
    const plan = createArtifactPlan(
      namespace,
      [createChange(safePath), createUnchangedChange(unsafePath)],
      [safePath, unsafePath],
    );

    try {
      await expect(
        materializeGeneratedArtifactPlan(namespace, plan),
      ).rejects.toThrow(/crosses a symbolic link/u);
      await expect(fileExists(safePath)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not change unchanged regular-file content or mtime', async () => {
    const fixture = await createFixture();
    const namespace = createLiminaArtifactNamespace({
      generation: 0,
      rootDir: fixture.rootDir,
    });
    const targetPath = fixture.path('.limina/generated.json');
    await mkdir(namespace.rootDir, { recursive: true });
    await writeFile(targetPath, 'generated\n');
    await utimes(targetPath, 1_700_000_000, 1_700_000_000);
    const before = await stat(targetPath);
    const plan = createArtifactPlan(
      namespace,
      [createUnchangedChange(targetPath)],
      [targetPath],
    );

    try {
      await materializeGeneratedArtifactPlan(namespace, plan);
      const after = await stat(targetPath);
      expect(await readFile(targetPath, 'utf8')).toBe('generated\n');
      expect(after.mtimeMs).toBe(before.mtimeMs);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(['create', 'update', 'delete'] as const)(
    'immediately rechecks a %s target after batch validation',
    async (status) => {
      const fixture = await createFixture();
      const namespace = createLiminaArtifactNamespace({
        generation: 0,
        rootDir: fixture.rootDir,
      });
      const externalPath = fixture.path('external.json');
      const targetPath = fixture.path(`.limina/${status}.json`);
      await mkdir(namespace.rootDir, { recursive: true });
      await writeFile(externalPath, 'external\n');
      if (status !== 'create') await writeFile(targetPath, 'generated\n');
      const change: ArtifactChange =
        status === 'delete'
          ? { path: targetPath, status }
          : {
              artifact: createChange(targetPath).artifact,
              status,
            };
      const plan = createArtifactPlan(namespace, [change], [targetPath]);

      try {
        await expect(
          materializeGeneratedArtifactPlan(namespace, plan, {
            afterPlanSafetyValidation: async () => {
              await rm(targetPath, { force: true });
              await symlink(externalPath, targetPath);
            },
          }),
        ).rejects.toThrow(/crosses a symbolic link/u);
        expect(await readFile(externalPath, 'utf8')).toBe('external\n');
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it('checks every unique batch safety node at most once', async () => {
    const fixture = await createFixture();
    const namespace = createLiminaArtifactNamespace({
      generation: 0,
      rootDir: fixture.rootDir,
    });
    const firstPath = fixture.path('.limina/shared/nested/first.json');
    const secondPath = fixture.path('.limina/shared/nested/second.json');
    await mkdir(path.dirname(firstPath), { recursive: true });
    await writeFile(firstPath, 'generated\n');
    await writeFile(secondPath, 'generated\n');
    const metrics = createProfilingMetricsRecorder();
    const plan = createArtifactPlan(
      namespace,
      [createUnchangedChange(firstPath), createUnchangedChange(secondPath)],
      [firstPath, secondPath],
    );

    try {
      await materializeGeneratedArtifactPlan(namespace, plan, { metrics });
      const snapshot = metrics.snapshot();
      const uniqueNodes = snapshot.find(
        (metric) => metric.name === 'artifact-safety-unique-node',
      )?.count;
      const lstatCalls = snapshot.find(
        (metric) => metric.name === 'artifact-safety-lstat',
      )?.count;
      expect(uniqueNodes).toBe(5);
      expect(lstatCalls).toBeLessThanOrEqual(uniqueNodes ?? 0);
    } finally {
      await fixture.cleanup();
    }
  });

  it('batch-validates and immediately rechecks a stale owned deletion', async () => {
    const fixture = await createFixture();
    const namespace = createLiminaArtifactNamespace({
      generation: 0,
      rootDir: fixture.rootDir,
    });
    const stalePath = fixture.path('.limina/stale.json');
    await mkdir(namespace.rootDir, { recursive: true });
    await writeFile(stalePath, 'stale\n');
    const metrics = createProfilingMetricsRecorder();
    const plan = createArtifactPlan(
      namespace,
      [{ path: stalePath, status: 'delete' }],
      [],
    );

    try {
      await materializeGeneratedArtifactPlan(namespace, plan, { metrics });
      await expect(fileExists(stalePath)).resolves.toBe(false);
      const snapshot = metrics.snapshot();
      expect(
        snapshot.find((metric) => metric.name === 'artifact-safety-lstat')
          ?.count,
      ).toBeGreaterThan(0);
      expect(
        snapshot.find(
          (metric) => metric.name === 'artifact-safety-immediate-recheck',
        )?.count,
      ).toBe(1);
      expect(
        snapshot.find((metric) => metric.name === 'artifact-mutation')?.count,
      ).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps the manifest last and unchanged when an earlier mutation fails', async () => {
    const fixture = await createFixture();
    const namespace = createLiminaArtifactNamespace({
      generation: 0,
      rootDir: fixture.rootDir,
    });
    const firstPath = fixture.path('.limina/a-first.json');
    const failingPath = fixture.path('.limina/z-failing.json');
    const manifestPath = fixture.path('.limina/manifest.json');
    await mkdir(namespace.rootDir, { recursive: true });
    await writeFile(failingPath, 'old\n');
    await writeFile(manifestPath, 'old manifest\n');
    const manifestChange: ArtifactChange = {
      artifact: {
        content: 'new manifest\n',
        kind: 'generated-manifest',
        origin: { domain: 'test' },
        path: manifestPath,
      },
      status: 'update',
    };
    const plan = createArtifactPlan(
      namespace,
      [
        createChange(firstPath),
        { artifact: createChange(failingPath).artifact, status: 'update' },
        manifestChange,
      ],
      [firstPath, failingPath, manifestPath],
    );
    const pendingMutations: string[] = [];

    try {
      await expect(
        materializeGeneratedArtifactPlan(namespace, plan, {
          beforeMutation(change) {
            const targetPath =
              change.status === 'delete' ? change.path : change.artifact.path;
            pendingMutations.push(targetPath);
            if (targetPath === failingPath) throw new Error('injected failure');
          },
        }),
      ).rejects.toThrow(/injected failure/u);
      expect(pendingMutations).toEqual([firstPath, failingPath]);
      expect(await readFile(firstPath, 'utf8')).toBe('generated\n');
      expect(await readFile(manifestPath, 'utf8')).toBe('old manifest\n');
    } finally {
      await fixture.cleanup();
    }
  });
});
