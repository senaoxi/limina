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
});
