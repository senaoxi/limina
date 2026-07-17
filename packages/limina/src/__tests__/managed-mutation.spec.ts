import type { ResolvedLiminaConfig } from '#config/runner';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LiminaPreflightManager } from '../preflight';
import {
  ManagedCheckerMutationCoordinator,
  proveManagedCheckerMutationContext,
} from '../typecheck/managed-mutation';
import {
  createCheckerTarget,
  type TypecheckTarget,
} from '../typecheck/targets';
import { normalizeAbsolutePath } from '../utils/path';

async function writeText(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

async function createFixture(): Promise<{
  cleanup: () => Promise<void>;
  config: ResolvedLiminaConfig;
  rootDir: string;
  sourceConfigPath: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-managed-mutation-')),
  );
  const sourceConfigPath = path.join(rootDir, 'packages/app/tsconfig.json');
  await writeText(
    path.join(rootDir, 'package.json'),
    '{"name":"root","private":true}\n',
  );
  await writeText(
    path.join(rootDir, 'pnpm-workspace.yaml'),
    'packages:\n  - packages/*\n',
  );
  await writeText(
    path.join(rootDir, 'packages/app/package.json'),
    '{"name":"@fixture/app","private":true}\n',
  );
  await writeText(
    path.join(rootDir, 'packages/app/tsconfig.base.json'),
    `${JSON.stringify({
      compilerOptions: {
        declaration: true,
        declarationMap: true,
        module: 'ESNext',
        moduleResolution: 'bundler',
        sourceMap: true,
        strict: true,
        target: 'ES2023',
        types: [],
      },
    })}\n`,
  );
  await writeText(
    sourceConfigPath,
    `${JSON.stringify({
      extends: './tsconfig.base.json',
      include: ['src/**/*.ts'],
      liminaOptions: {
        outputs: {
          declarationMap: true,
          outDir: './dist',
          rootDir: './src',
        },
      },
    })}\n`,
  );
  await writeText(
    path.join(rootDir, 'packages/app/src/index.ts'),
    'export const value = 1;\n',
  );
  return {
    cleanup: () => rm(rootDir, { force: true, recursive: true }),
    config: {
      config: {
        checkers: {
          typescript: {
            include: ['packages/app/tsconfig.json'],
            preset: 'tsc',
          },
        },
      },
      configPath: path.join(rootDir, 'limina.config.mjs'),
      rootDir,
    },
    rootDir,
    sourceConfigPath,
  };
}

async function prepareManagedTarget(
  fixture: Awaited<ReturnType<typeof createFixture>>,
): Promise<{
  coordinator: ManagedCheckerMutationCoordinator;
  manager: LiminaPreflightManager;
  target: TypecheckTarget;
}> {
  const manager = new LiminaPreflightManager({ config: fixture.config });
  const workspaceContext = await manager.ensureWorkspaceValidated();
  const { graph } = await manager.ensureGeneratedArtifactsMaterialized();
  const checker = graph.checkers.find(
    (candidate) => candidate.name === 'typescript',
  )!;
  const buildModule = graph.configToOutputBuild
    .get('typescript')
    ?.get(fixture.sourceConfigPath);
  if (!buildModule || buildModule.kind !== 'project') {
    throw new Error('Missing generated output project for test fixture.');
  }
  const target = createCheckerTarget({
    checker,
    configPath: buildModule.path,
    executionKind: 'build',
    projectRootDir: fixture.rootDir,
    sourceConfigPath: fixture.sourceConfigPath,
  });
  const coordinator = await ManagedCheckerMutationCoordinator.create({
    artifactNamespace: manager.artifactNamespace,
    checkers: graph.checkers,
    config: fixture.config,
    generatedGraph: graph,
    targets: [target],
    workspaceContext,
  });
  return { coordinator, manager, target };
}

describe('managed checker mutation proof', () => {
  it('projects JS, declaration, map, and exact tsbuildinfo outputs from effective config', async () => {
    const fixture = await createFixture();
    try {
      const manager = new LiminaPreflightManager({ config: fixture.config });
      const workspaceContext = await manager.ensureWorkspaceValidated();
      const { graph } = await manager.ensureGeneratedArtifactsMaterialized();
      const checker = graph.checkers.find(
        (candidate) => candidate.name === 'typescript',
      )!;
      const buildModule = graph.configToOutputBuild
        .get('typescript')
        ?.get(fixture.sourceConfigPath);
      if (!buildModule || buildModule.kind !== 'project') {
        throw new Error('Missing generated output project for test fixture.');
      }
      const target = createCheckerTarget({
        checker,
        configPath: buildModule.path,
        executionKind: 'build',
        projectRootDir: fixture.rootDir,
        sourceConfigPath: fixture.sourceConfigPath,
      });
      const proof = await proveManagedCheckerMutationContext({
        artifactNamespace: manager.artifactNamespace,
        checkers: graph.checkers,
        generatedGraph: graph,
        projectRootDir: fixture.rootDir,
        target,
        workspaceContext,
      });
      const relativeOutputs = proof.projectedOutputPaths.map((outputPath) =>
        path.relative(fixture.rootDir, outputPath).replaceAll(path.sep, '/'),
      );

      expect(relativeOutputs).toEqual(
        expect.arrayContaining([
          'packages/app/dist/index.js',
          'packages/app/dist/index.js.map',
          'packages/app/dist/index.d.ts',
          'packages/app/dist/index.d.ts.map',
          '.limina/tsbuildinfo/build/packages/app/tsconfig.tsbuildinfo',
        ]),
      );
      expect(proof.effectiveOptionsFingerprint).toMatch(/^[\da-f]{64}$/u);
      expect(proof.checkerImplementationFingerprint).toMatch(/^[\da-f]{64}$/u);

      const dtsConfigPath = [
        ...(graph.dtsToSource.get('typescript') ?? []),
      ].find(
        ([, sourceConfigPath]) =>
          normalizeAbsolutePath(sourceConfigPath) === fixture.sourceConfigPath,
      )?.[0];
      if (!dtsConfigPath) {
        throw new Error('Missing generated declaration project for fixture.');
      }
      const dtsTarget = createCheckerTarget({
        checker,
        configPath: dtsConfigPath,
        executionKind: 'build',
        projectRootDir: fixture.rootDir,
        sourceConfigPath: fixture.sourceConfigPath,
      });
      const dtsProof = await proveManagedCheckerMutationContext({
        artifactNamespace: manager.artifactNamespace,
        checkers: graph.checkers,
        generatedGraph: graph,
        projectRootDir: fixture.rootDir,
        target: dtsTarget,
        workspaceContext,
      });
      expect(
        dtsProof.projectedOutputPaths.map((outputPath) =>
          path.relative(fixture.rootDir, outputPath).replaceAll(path.sep, '/'),
        ),
      ).toEqual(
        expect.arrayContaining([
          '.limina/dts/checkers/typescript/packages/app/tsconfig/index.d.ts',
          '.limina/tsbuildinfo/checkers/typescript/packages/app/tsconfig.tsbuildinfo',
        ]),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects effective config drift between layer barrier and target run', async () => {
    const fixture = await createFixture();
    try {
      const { coordinator, target } = await prepareManagedTarget(fixture);
      await coordinator.beforeLayerRun([target]);
      await writeText(
        path.join(fixture.rootDir, 'packages/app/tsconfig.base.json'),
        `${JSON.stringify({
          compilerOptions: {
            declaration: true,
            declarationMap: false,
            module: 'ESNext',
            moduleResolution: 'bundler',
            sourceMap: false,
            strict: true,
            target: 'ES2023',
            types: [],
          },
        })}\n`,
      );

      await expect(coordinator.beforeTargetRun(target)).rejects.toThrow(
        'emit proof drifted immediately before runner',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects a final output symlink inserted after the layer barrier', async () => {
    const fixture = await createFixture();
    const markerPath = path.join(fixture.rootDir, 'external/marker.txt');
    try {
      const { coordinator, target } = await prepareManagedTarget(fixture);
      await coordinator.beforeLayerRun([target]);
      await writeText(markerPath, 'external marker bytes\n');
      await mkdir(path.join(fixture.rootDir, 'packages/app/dist'), {
        recursive: true,
      });
      await symlink(
        markerPath,
        path.join(fixture.rootDir, 'packages/app/dist/index.d.ts'),
      );

      await expect(coordinator.beforeTargetRun(target)).rejects.toThrow(
        /symbolic link|drifted after preflight/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });
});
