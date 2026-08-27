import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import { normalizeAbsolutePath } from '#utils/path';
import { existsSync, readFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import { runProofCheck } from '../commands/proof';
import { collectValidatedWorkspaceContext } from '../core/workspace/validated-context';
import { createLiminaArtifactNamespace } from '../domain/artifacts/namespace';
import { createArtifactPlan } from '../domain/artifacts/plan';
import { ProofLogger } from '../logger';
import {
  type ProofFinding,
  type ProofFindingForCode,
  type ProofSemanticIssueCode,
} from '../proof/findings';
import { runProofCheckImpl } from '../proof/runner';
import { collectExpectedSourceFiles } from '../proof/source-files';
import {
  type LiminaCheckIssue,
  readCheckIssueSnapshot,
} from '../source-check/snapshot';
import { prepareAndMaterializeGeneratedTsconfigGraph } from './helpers/generated-graph';
import { toPortablePath } from './helpers/path';

const requireFromTest = createRequire(import.meta.url);

function resolveInstalledPackageRoot(
  installedName: string,
  packageName: string,
): string {
  let directory = path.dirname(requireFromTest.resolve(installedName));

  while (true) {
    const manifestPath = path.join(directory, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        name?: string;
      };
      if (manifest.name === packageName) return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(`Unable to find the ${packageName} package root.`);
    }
    directory = parent;
  }
}

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

function stringifyConfig(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const svelteCheckerPeerFiles = {
  'node_modules/svelte-check/package.json': stringifyConfig({
    name: 'svelte-check',
    version: '4.0.0',
  }),
  'node_modules/typescript/package.json': stringifyConfig({
    name: 'typescript',
    version: '5.9.0',
  }),
};

function getFixtureWorkspacePackageManifestPath(
  relativePath: string,
): string | null {
  const segments = relativePath.split('/');

  if (
    segments[0] !== 'packages' ||
    !segments[1] ||
    segments.length < 3 ||
    segments[2] === 'package.json'
  ) {
    return null;
  }

  return `packages/${segments[1]}/package.json`;
}

function createFixtureFiles(
  files: Record<string, string>,
): Record<string, string> {
  const gitignore = [
    'package.json',
    'tsconfig*.json',
    '**/tsconfig*.json',
    files['.gitignore'] ?? '',
  ].join('\n');
  const packageManifests: Record<string, string> = {
    'package.json': stringifyConfig({
      name: 'fixture-root',
      private: true,
    }),
  };

  for (const relativePath of Object.keys(files)) {
    const packageJsonPath =
      getFixtureWorkspacePackageManifestPath(relativePath);

    if (!packageJsonPath || Object.hasOwn(files, packageJsonPath)) {
      continue;
    }

    const packageDirectory = path.posix.dirname(packageJsonPath);
    const packageName = path.posix.basename(packageDirectory);

    packageManifests[packageJsonPath] = stringifyConfig({
      name: `@fixture/${packageName}`,
      private: true,
    });
  }

  return {
    'pnpm-workspace.yaml': 'packages:\n  - app\n  - packages/*\n',
    ...packageManifests,
    ...files,
    '.gitignore': gitignore,
  };
}

function getSvelteFixtureRoots(
  files: Record<string, string>,
  rootDir: string,
): string[] {
  return [
    ...new Set(
      Object.keys(files)
        .filter((filePath) => filePath.endsWith('.svelte'))
        .map((filePath) => {
          const segments = filePath.split('/');
          return segments[0] === 'packages' && segments[1]
            ? path.join(rootDir, 'packages', segments[1])
            : rootDir;
        }),
    ),
  ];
}

async function linkSvelteSemanticToolchain(rootDir: string): Promise<void> {
  const compilerRoot = resolveInstalledPackageRoot(
    'svelte-v4-min/package.json',
    'svelte',
  );
  const transformRoot = resolveInstalledPackageRoot(
    'svelte2tsx/package.json',
    'svelte2tsx',
  );
  const typeScriptRoot = resolveInstalledPackageRoot(
    'typescript/package.json',
    'typescript',
  );
  const nodeModulesDir = path.join(rootDir, 'node_modules');
  await mkdir(nodeModulesDir, { recursive: true });
  await rm(path.join(nodeModulesDir, 'typescript'), {
    force: true,
    recursive: true,
  });
  await Promise.all([
    symlink(compilerRoot, path.join(nodeModulesDir, 'svelte'), 'junction'),
    symlink(transformRoot, path.join(nodeModulesDir, 'svelte2tsx'), 'junction'),
    symlink(
      typeScriptRoot,
      path.join(nodeModulesDir, 'typescript'),
      'junction',
    ),
  ]);
}

async function createFixture(files: Record<string, string>): Promise<{
  cleanup: () => Promise<void>;
  config: ResolvedLiminaConfig;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-proof-')),
  );
  const fixtureFiles = createFixtureFiles(files);

  for (const [relativePath, text] of Object.entries(fixtureFiles)) {
    await writeText(path.join(rootDir, relativePath), text);
  }
  await Promise.all(
    getSvelteFixtureRoots(files, rootDir).map(linkSvelteSemanticToolchain),
  );
  const vueTscManifest = requireFromTest.resolve('vue-tsc/package.json');
  await mkdir(path.join(rootDir, 'node_modules'), { recursive: true });
  await symlink(
    path.dirname(vueTscManifest),
    path.join(rootDir, 'node_modules/vue-tsc'),
    'junction',
  );

  return {
    cleanup: async () => {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    },
    config: {
      config: {
        checkers: {
          tsc: {
            include: ['tsconfig.json', '**/tsconfig.json'],
          },
        },
      },
      configPath: path.join(rootDir, 'limina.config.mjs'),
      rootDir,
    },
    rootDir,
  };
}

async function collectProofIssues(config: ResolvedLiminaConfig): Promise<{
  issues: LiminaCheckIssue[];
  passed: boolean;
}> {
  const issues: LiminaCheckIssue[] = [];
  const passed = await runProofCheck(config, {
    clearScreen: false,
    deferSnapshot: true,
    issues,
    report: {
      defer: true,
    },
  });

  return {
    issues,
    passed,
  };
}

async function collectTypedProofFindings(
  config: ResolvedLiminaConfig,
  options: NonNullable<Parameters<typeof runProofCheckImpl>[1]> = {},
): Promise<{
  findings: ProofFinding[];
  issues: LiminaCheckIssue[];
  passed: boolean;
}> {
  const findings: ProofFinding[] = [];
  const issues: LiminaCheckIssue[] = [];
  const passed = await runProofCheckImpl(config, {
    ...options,
    deferSnapshot: true,
    findingSink: findings,
    issues,
    logSuccess: false,
    report: {
      ...options.report,
      defer: true,
    },
  });

  return { findings, issues, passed };
}

function requireProofFinding<Code extends ProofSemanticIssueCode>(
  findings: readonly ProofFinding[],
  code: Code,
): ProofFindingForCode<Code> {
  const finding = findings.find((candidate) => candidate.code === code);

  if (!finding) {
    throw new Error(`Expected Proof finding ${code}.`);
  }

  return finding as ProofFindingForCode<Code>;
}

function collectUncoveredSourceIssueFiles(
  issues: readonly LiminaCheckIssue[],
): string[] {
  return issues
    .flatMap((issue) =>
      issue.code === 'LIMINA_PROOF_UNCOVERED_SOURCE_FILE' && issue.filePath
        ? [issue.filePath]
        : [],
    )
    .sort();
}

function createPassingFiles(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    'packages/pkg/src/index.ts': 'export const value = 1;\n',
    'packages/pkg/tsconfig.json': JSON.stringify({
      compilerOptions: {
        lib: ['ES2023'],
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        target: 'ES2023',
        types: [],
      },
      include: ['src/**/*.ts'],
    }),
    'tsconfig.json': JSON.stringify({
      files: [],
      references: [
        {
          path: './packages/pkg/tsconfig.json',
        },
      ],
    }),
    ...overrides,
  };
}

function createSingleEnvironmentFiles(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    'packages/pkg/src/index.ts': 'export const value = 1;\n',
    'packages/pkg/tsconfig.json': JSON.stringify({
      compilerOptions: {
        lib: ['ES2023'],
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        target: 'ES2023',
        types: [],
      },
      include: ['src/**/*.ts'],
    }),
    'tsconfig.json': JSON.stringify({
      files: [],
      references: [
        {
          path: './packages/pkg/tsconfig.json',
        },
      ],
    }),
    ...overrides,
  };
}

function createMultiEnvironmentFiles(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return createPassingFiles({
    'packages/pkg/tsconfig.lib.json': JSON.stringify({
      compilerOptions: {
        lib: ['ES2023'],
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        target: 'ES2023',
        types: [],
      },
      include: ['src/**/*.ts'],
    }),
    'packages/pkg/tsconfig.test.json': JSON.stringify({
      compilerOptions: {
        lib: ['ES2023'],
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        target: 'ES2023',
        types: [],
      },
      include: ['src/**/*.ts'],
    }),
    'packages/pkg/tsconfig.json': JSON.stringify({
      files: [],
      references: [
        {
          path: './tsconfig.lib.json',
        },
        {
          path: './tsconfig.test.json',
        },
      ],
    }),
    ...overrides,
  });
}

function createCheckerGraphCoverageProofGeneratedGraph(
  rootDir: string,
): GeneratedTsconfigGraphResult {
  const artifactNamespace = createLiminaArtifactNamespace({
    generation: 0,
    rootDir,
  });
  const checkerEntryPath = normalizeAbsolutePath(
    path.join(rootDir, '.limina/tsconfig.typescript.build.json'),
  );

  return {
    artifactPlan: createArtifactPlan(artifactNamespace, [], []),
    changed: false,
    checkerEntries: new Map([['tsc', checkerEntryPath]]),
    checkers: [
      {
        exclude: [],
        extensions: [],
        include: ['tsconfig.json', '**/tsconfig.json'],
        name: 'tsc',
      },
    ],
    configToOutputBuild: new Map(),
    dtsToSource: new Map(),
    generatedKnipConfigs: [],
    generatedKnipDiagnostics: [],
    generatedFiles: new Map(),
    governedSources: new Map(),
    manifest: {
      checkers: {},
      generatedBy: 'limina',
      knip: {
        diagnostics: [],
        packages: [],
      },
      ownedArtifacts: [],
      ownership: { configs: [], solutions: [] },
      targets: { build: [], framework: [] },
      dependencyEdges: [],
      version: 5,
    },
    manifestPath: path.join(rootDir, '.limina/manifest.json'),
    outputDeclarationCopies: new Map(),
    ownershipPlan: {
      dependencyFacts: [],
      entryOwnerByConfigPath: new Map(),
      solutions: new Map(),
      typeConfigs: new Map(),
    },
    dependencyEdges: [],
    sourceToBuild: new Map(),
    sourceToDts: new Map(),
  };
}

type MutableFrameworkProofGraph = Omit<
  GeneratedTsconfigGraphResult,
  'generatedFiles'
> & {
  generatedFiles: Map<string, string>;
};

function cloneFrameworkProofGraph(
  graph: GeneratedTsconfigGraphResult,
): MutableFrameworkProofGraph {
  return {
    ...graph,
    generatedFiles: new Map(graph.generatedFiles),
    governedSources: new Map(
      [...graph.governedSources.entries()].map(([checkerName, units]) => [
        checkerName,
        new Map(
          [...units.entries()].map(([configPath, unit]) => [
            configPath,
            {
              ...unit,
              buildProjection: { ...unit.buildProjection },
              declarationFileNames: [...unit.declarationFileNames],
              declarationReferences: new Set(unit.declarationReferences),
              frameworkCapabilities: unit.frameworkCapabilities.map(
                (capability) => ({ ...capability }),
              ),
              ownedFileNames: [...unit.ownedFileNames],
            },
          ]),
        ),
      ]),
    ),
    sourceToBuild: new Map(
      [...graph.sourceToBuild.entries()].map(([checkerName, modules]) => [
        checkerName,
        new Map(modules),
      ]),
    ),
    sourceToDts: new Map(
      [...graph.sourceToDts.entries()].map(([checkerName, sourceToDts]) => [
        checkerName,
        new Map(sourceToDts),
      ]),
    ),
  };
}

function findCheckerCoverageFact(
  findings: readonly ProofFinding[],
  kind:
    | 'build-projection'
    | 'framework-target'
    | 'generated-build-extension'
    | 'primary-owner'
    | 'framework-capability',
) {
  return findings.find(
    (finding) =>
      finding.code === LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid &&
      finding.facts.kind === kind,
  );
}

describe('runProofCheck dts config semantics', () => {
  it('accepts a single-environment dts leaf paired with default tsconfig.json', async () => {
    const fixture = await createFixture(createPassingFiles());

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('proves framework ownership, targets, and non-build projections', async () => {
    const fixture = await createFixture({
      'node_modules/svelte-check/package.json': stringifyConfig({
        name: 'svelte-check',
        version: '4.0.0',
      }),
      'node_modules/typescript/package.json': stringifyConfig({
        name: 'tsc',
        version: '5.9.0',
      }),
      'packages/app/node_modules/svelte-check/package.json': stringifyConfig({
        name: 'svelte-check',
        version: '4.0.0',
      }),
      'packages/app/node_modules/typescript/package.json': stringifyConfig({
        name: 'tsc',
        version: '5.9.0',
      }),
      'packages/app/src/App.svelte':
        '<script lang="ts">export const value = 1;</script>\n',
      'packages/app/src/index.ts': 'export const nativeValue = 1;\n',
      'packages/app/tsconfig.json': stringifyConfig({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*'],
      }),
      'tsconfig.json': stringifyConfig({
        files: [],
        references: [{ path: './packages/app/tsconfig.json' }],
      }),
    });
    const config: ResolvedLiminaConfig = {
      ...fixture.config,
      config: {
        checkers: { auto: {} },
        source: { include: ['...', '**/*.svelte'] },
      },
    };

    try {
      const graph = await prepareAndMaterializeGeneratedTsconfigGraph(config);
      const checkerName = 'svelte-check';
      const sourceConfigPath = normalizeAbsolutePath(
        path.join(fixture.rootDir, 'packages/app/tsconfig.json'),
      );
      const baseline = await collectTypedProofFindings(config, {
        generatedGraphProvider: async () => graph,
      });

      expect(baseline.findings.map((finding) => finding.facts)).toEqual([]);
      expect(baseline.passed).toBe(true);

      const missingCapability = cloneFrameworkProofGraph(graph);
      missingCapability.governedSources
        .get(checkerName)!
        .get(sourceConfigPath)!.frameworkCapabilities = [];
      const missingResult = await collectTypedProofFindings(config, {
        generatedGraphProvider: async () => missingCapability,
      });
      expect(
        findCheckerCoverageFact(missingResult.findings, 'framework-capability')
          ?.facts,
      ).toMatchObject({
        family: 'svelte',
        kind: 'framework-capability',
        violation: 'missing',
      });

      const duplicateCapability = cloneFrameworkProofGraph(graph);
      const duplicateUnit = duplicateCapability.governedSources
        .get(checkerName)!
        .get(sourceConfigPath)!;
      duplicateUnit.frameworkCapabilities.push({
        ...duplicateUnit.frameworkCapabilities[0]!,
      });
      const duplicateResult = await collectTypedProofFindings(config, {
        generatedGraphProvider: async () => duplicateCapability,
      });
      expect(
        findCheckerCoverageFact(
          duplicateResult.findings,
          'framework-capability',
        )?.facts,
      ).toMatchObject({
        family: 'svelte',
        kind: 'framework-capability',
        violation: 'duplicate',
      });

      const duplicatePrimary = cloneFrameworkProofGraph(graph);
      duplicatePrimary.governedSources.set(
        'tsgo',
        new Map([
          [
            sourceConfigPath,
            {
              ...duplicatePrimary.governedSources
                .get(checkerName)!
                .get(sourceConfigPath)!,
              primaryCheckerName: 'tsgo',
            },
          ],
        ]),
      );
      const primaryResult = await collectTypedProofFindings(config, {
        generatedGraphProvider: async () => duplicatePrimary,
      });
      expect(
        findCheckerCoverageFact(primaryResult.findings, 'primary-owner')?.facts,
      ).toMatchObject({ kind: 'primary-owner' });

      expect(graph.sourceToDts.get(checkerName)?.get(sourceConfigPath)).toBe(
        undefined,
      );
      expect(
        graph.governedSources.get(checkerName)?.get(sourceConfigPath)
          ?.buildProjection.kind,
      ).toBe('framework-checker');

      const dtsConfigPath = normalizeAbsolutePath(
        path.join(fixture.rootDir, '.limina/invalid-svelte.dts.json'),
      );
      const invalidProjection = cloneFrameworkProofGraph(graph);
      invalidProjection.sourceToDts.set(
        checkerName,
        new Map([[sourceConfigPath, dtsConfigPath]]),
      );
      const projectionResult = await collectTypedProofFindings(config, {
        generatedGraphProvider: async () => invalidProjection,
      });
      expect(
        findCheckerCoverageFact(projectionResult.findings, 'build-projection')
          ?.facts,
      ).toMatchObject({
        kind: 'build-projection',
        violation: 'declaration-provider-mismatch',
      });

      const invalidSolutionKind = cloneFrameworkProofGraph(graph);
      const invalidKindUnit = invalidSolutionKind.governedSources
        .get(checkerName)!
        .get(sourceConfigPath)!;
      invalidKindUnit.buildProjection = {
        dtsConfigPath,
        kind: 'declaration-project',
      };
      const solutionKindResult = await collectTypedProofFindings(config, {
        generatedGraphProvider: async () => invalidSolutionKind,
      });
      expect(
        findCheckerCoverageFact(solutionKindResult.findings, 'build-projection')
          ?.facts,
      ).toMatchObject({
        kind: 'build-projection',
        violation: 'solution-kind-mismatch',
      });

      const missingDependencyRoot = await realpath(
        await mkdtemp(path.join(tmpdir(), 'limina-proof-missing-deps-')),
      );
      const missingTarget = cloneFrameworkProofGraph(graph);
      missingTarget.governedSources
        .get(checkerName)!
        .get(sourceConfigPath)!.frameworkCapabilities[0]!.packageRootDir =
        missingDependencyRoot;
      const targetResult = await collectTypedProofFindings(config, {
        generatedGraphProvider: async () => missingTarget,
      });
      expect(
        findCheckerCoverageFact(targetResult.findings, 'framework-target')
          ?.facts,
      ).toMatchObject({
        family: 'svelte',
        kind: 'framework-target',
        violation: 'preflight-failed',
      });
      await rm(missingDependencyRoot, { force: true, recursive: true });
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects missing typecheck declaration companions', async () => {
    const fixture = await createFixture(createMultiEnvironmentFiles());

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('emits a typed checker-coverage finding for a missing generated entry', async () => {
    const fixture = await createFixture(createPassingFiles());

    try {
      const generatedGraph = createCheckerGraphCoverageProofGeneratedGraph(
        fixture.rootDir,
      );
      const result = await collectTypedProofFindings(fixture.config, {
        generatedGraphProvider: async () => ({
          ...generatedGraph,
          checkerEntries: new Map(),
        }),
      });
      const finding = requireProofFinding(
        result.findings,
        LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
      );

      expect(result.passed).toBe(false);
      expect(finding).toMatchObject({
        checkerName: 'tsc',
        code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
        facts: {
          checkerName: 'tsc',
          diagnosticReason:
            'run limina graph prepare before collecting checker graph routes.',
          diagnosticTitle: 'Missing generated checker graph entry',
          kind: 'checker-route',
          projection: 'graph',
        },
        task: 'proof:check',
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores inert dts leaves that do not transitively extend their companion', async () => {
    const fixture = await createFixture(
      createSingleEnvironmentFiles({
        'packages/pkg/tsconfig.dts.json': JSON.stringify({
          compilerOptions: {
            composite: true,
            declaration: true,
            emitDeclarationOnly: true,
            lib: ['ES2023'],
            module: 'ESNext',
            moduleResolution: 'bundler',
            noEmit: false,
            outDir: './.tsbuild',
            rootDir: 'src',
            strict: true,
            target: 'ES2023',
            tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
            types: [],
          },
          include: ['src/**/*.ts'],
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores inert declaration helper configs outside managed entries', async () => {
    const fixture = await createFixture(
      createSingleEnvironmentFiles({
        'packages/pkg/tsconfig.dts.base.json': JSON.stringify({
          extends: './tsconfig.json',
        }),
        'packages/pkg/tsconfig.dts.json': JSON.stringify({
          extends: './tsconfig.dts.base.json',
          compilerOptions: {
            composite: true,
            declaration: true,
            emitDeclarationOnly: true,
            noEmit: false,
            outDir: './.tsbuild',
            rootDir: 'src',
            tsBuildInfoFile: './.tsbuild/build.tsbuildinfo',
          },
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects removed metadata in a source-level declaration config interpreted by proof', async () => {
    const fixture = await createFixture(
      createSingleEnvironmentFiles({
        '.limina/tsconfig.typescript.build.json': JSON.stringify({
          files: [],
          references: [
            {
              path: '../packages/pkg/tsconfig.dts.json',
            },
          ],
        }),
        'packages/pkg/tsconfig.dts.json': JSON.stringify({
          extends: './tsconfig.json',
          limina: 'runtime',
        }),
      }),
    );

    try {
      await expect(
        runProofCheck(fixture.config, {
          deferSnapshot: true,
          generatedGraphProvider: async () =>
            createCheckerGraphCoverageProofGeneratedGraph(fixture.rootDir),
          report: {
            defer: true,
          },
        }),
      ).rejects.toThrow(
        'root-level limina metadata is not part of the Limina 0.2.0 tsconfig contract',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores inert build graph references to ordinary configs', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'tsconfig.extra.build.json': JSON.stringify({
          files: [],
          references: [
            {
              path: './packages/pkg/tsconfig.json',
            },
          ],
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects duplicate ordinary typecheck ownership for implementation sources', async () => {
    const fixture = await createFixture(createMultiEnvironmentFiles());

    try {
      const result = await collectTypedProofFindings(fixture.config);
      const finding = requireProofFinding(
        result.findings,
        LIMINA_CHECK_ISSUE_CODES.proofDuplicateSourceOwner,
      );

      expect(result.passed).toBe(false);
      expect(finding).toMatchObject({
        code: LIMINA_CHECK_ISSUE_CODES.proofDuplicateSourceOwner,
        facts: {
          checkerNames: ['tsc'],
          kind: 'multiple-typecheck-owners',
          ownerProjectPaths: [
            toPortablePath(
              path.join(fixture.rootDir, 'packages/pkg/tsconfig.lib.json'),
            ),
            toPortablePath(
              path.join(fixture.rootDir, 'packages/pkg/tsconfig.test.json'),
            ),
          ],
          sourcePath: toPortablePath(
            path.join(fixture.rootDir, 'packages/pkg/src/index.ts'),
          ),
        },
        packageManifestPath: toPortablePath(
          path.join(fixture.rootDir, 'packages/pkg/package.json'),
        ),
        packageName: '@fixture/pkg',
        task: 'proof:check',
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports duplicate checker graph coverage for implementation sources with its own issue code', async () => {
    const fixture = await createFixture({
      '.limina/tsconfig.typescript.build.json': JSON.stringify({
        files: [],
        references: [
          {
            path: '../packages/pkg/tsconfig.alpha.dts.json',
          },
          {
            path: '../packages/pkg/tsconfig.beta.dts.json',
          },
        ],
      }),
      'packages/pkg/src/shared.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.alpha.dts.json': JSON.stringify({
        extends: './tsconfig.alpha.json',
        compilerOptions: {
          composite: true,
          declaration: true,
          emitDeclarationOnly: true,
          noEmit: false,
          outDir: './.tsbuild/alpha',
          tsBuildInfoFile: './.tsbuild/alpha.tsbuildinfo',
        },
        liminaOptions: {
          sourceConfig: './tsconfig.alpha.json',
        },
      }),
      'packages/pkg/tsconfig.alpha.json': JSON.stringify({
        compilerOptions: {
          lib: ['ES2023'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/shared.ts'],
      }),
      'packages/pkg/tsconfig.beta.dts.json': JSON.stringify({
        extends: './tsconfig.beta.json',
        compilerOptions: {
          composite: true,
          declaration: true,
          emitDeclarationOnly: true,
          noEmit: false,
          outDir: './.tsbuild/beta',
          tsBuildInfoFile: './.tsbuild/beta.tsbuildinfo',
        },
        liminaOptions: {
          sourceConfig: './tsconfig.beta.json',
        },
      }),
      'packages/pkg/tsconfig.beta.json': JSON.stringify({
        compilerOptions: {
          lib: ['ES2023'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/shared.ts'],
      }),
      'packages/pkg/tsconfig.json': JSON.stringify({
        files: [],
        references: [
          {
            path: './tsconfig.alpha.json',
          },
          {
            path: './tsconfig.beta.json',
          },
        ],
      }),
      'tsconfig.json': JSON.stringify({
        files: [],
        references: [
          {
            path: './packages/pkg/tsconfig.json',
          },
        ],
      }),
    });
    try {
      const result = await collectTypedProofFindings(fixture.config, {
        deferSnapshot: true,
        generatedGraphProvider: async () =>
          createCheckerGraphCoverageProofGeneratedGraph(fixture.rootDir),
      });
      const finding = requireProofFinding(
        result.findings,
        LIMINA_CHECK_ISSUE_CODES.proofDuplicateGraphCoverage,
      );

      expect(result.passed).toBe(false);
      expect(finding).toMatchObject({
        code: LIMINA_CHECK_ISSUE_CODES.proofDuplicateGraphCoverage,
        facts: {
          checkerNames: ['tsc'],
          checkerPreset: 'tsc',
          declarationProjectPaths: [
            toPortablePath(
              path.join(
                fixture.rootDir,
                'packages/pkg/tsconfig.alpha.dts.json',
              ),
            ),
            toPortablePath(
              path.join(fixture.rootDir, 'packages/pkg/tsconfig.beta.dts.json'),
            ),
          ],
          graphEntryPaths: [
            toPortablePath(
              path.join(
                fixture.rootDir,
                '.limina/tsconfig.typescript.build.json',
              ),
            ),
          ],
          kind: 'multiple-declaration-projects',
          sourcePath: toPortablePath(
            path.join(fixture.rootDir, 'packages/pkg/src/shared.ts'),
          ),
        },
        task: 'proof:check',
      });

      expect(result.issues).toContainEqual(
        expect.objectContaining({
          code: 'LIMINA_PROOF_DUPLICATE_GRAPH_COVERAGE',
          filePath: 'packages/pkg/src/shared.ts',
          task: 'proof:check',
          title: 'Duplicate checker graph coverage',
        }),
      );
      expect(result.issues).not.toContainEqual(
        expect.objectContaining({
          code: 'LIMINA_PROOF_DUPLICATE_SOURCE_OWNER',
          title: 'Duplicate checker graph coverage',
        }),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows shared declaration input files across generated checker graph dts configs', async () => {
    const fixture = await createFixture({
      '.limina/tsconfig.typescript.build.json': JSON.stringify({
        files: [],
        references: [
          {
            path: '../packages/pkg/tsconfig.lib.dts.json',
          },
          {
            path: '../packages/pkg/tsconfig.test.dts.json',
          },
        ],
      }),
      'packages/pkg/src/lib.ts': 'export const lib = 1;\n',
      'packages/pkg/src/shared.d.cts':
        'declare const sharedCommonJsDeclaration: string;\n',
      'packages/pkg/src/shared.d.mts':
        'declare const sharedModuleDeclaration: string;\n',
      'packages/pkg/src/shared.d.ts':
        'declare const sharedGlobalDeclaration: string;\n',
      'packages/pkg/test/index.ts': 'export const test = 1;\n',
      'packages/pkg/tsconfig.lib.dts.json': JSON.stringify({
        extends: './tsconfig.lib.json',
        compilerOptions: {
          composite: true,
          declaration: true,
          emitDeclarationOnly: true,
          noEmit: false,
          outDir: './.tsbuild/lib',
          tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
        },
        liminaOptions: {
          sourceConfig: './tsconfig.lib.json',
        },
      }),
      'packages/pkg/tsconfig.lib.json': JSON.stringify({
        compilerOptions: {
          lib: ['ES2023'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: [
          'src/lib.ts',
          'src/shared.d.cts',
          'src/shared.d.mts',
          'src/shared.d.ts',
        ],
      }),
      'packages/pkg/tsconfig.test.dts.json': JSON.stringify({
        extends: './tsconfig.test.json',
        compilerOptions: {
          composite: true,
          declaration: true,
          emitDeclarationOnly: true,
          noEmit: false,
          outDir: './.tsbuild/test',
          tsBuildInfoFile: './.tsbuild/test.tsbuildinfo',
        },
        liminaOptions: {
          sourceConfig: './tsconfig.test.json',
        },
      }),
      'packages/pkg/tsconfig.test.json': JSON.stringify({
        compilerOptions: {
          lib: ['ES2023'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: [
          'test/index.ts',
          'src/shared.d.cts',
          'src/shared.d.mts',
          'src/shared.d.ts',
        ],
      }),
      'packages/pkg/tsconfig.json': JSON.stringify({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
          {
            path: './tsconfig.test.json',
          },
        ],
      }),
      'tsconfig.json': JSON.stringify({
        files: [],
        references: [
          {
            path: './packages/pkg/tsconfig.json',
          },
        ],
      }),
    });
    const issues: LiminaCheckIssue[] = [];

    try {
      await expect(
        runProofCheck(fixture.config, {
          deferSnapshot: true,
          generatedGraphProvider: async () =>
            createCheckerGraphCoverageProofGeneratedGraph(fixture.rootDir),
          issues,
          report: {
            defer: true,
          },
        }),
      ).resolves.toBe(true);

      expect(issues).not.toContainEqual(
        expect.objectContaining({
          code: 'LIMINA_PROOF_DUPLICATE_GRAPH_COVERAGE',
        }),
      );
      expect(issues).not.toContainEqual(
        expect.objectContaining({
          filePath: 'packages/pkg/src/shared.d.cts',
          title: 'Duplicate checker graph coverage',
        }),
      );
      expect(issues).not.toContainEqual(
        expect.objectContaining({
          filePath: 'packages/pkg/src/shared.d.mts',
          title: 'Duplicate checker graph coverage',
        }),
      );
      expect(issues).not.toContainEqual(
        expect.objectContaining({
          filePath: 'packages/pkg/src/shared.d.ts',
          title: 'Duplicate checker graph coverage',
        }),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows pnpm-like shared typings across generated checker graph dts configs', async () => {
    const fixture = await createFixture({
      '.limina/tsconfig.typescript.build.json': JSON.stringify({
        files: [],
        references: [
          {
            path: '../packages/pkg/tsconfig.lib.dts.json',
          },
          {
            path: '../packages/pkg/tsconfig.test.dts.json',
          },
        ],
      }),
      'packages/pkg/__typings__/index.d.ts':
        'export interface SharedIndexTyping { value: string; }\n',
      'packages/pkg/__typings__/local.d.ts':
        'export interface SharedLocalTyping { value: string; }\n',
      'packages/pkg/__typings__/typed.d.ts':
        'export interface SharedTypedTyping { value: string; }\n',
      'packages/pkg/src/lib.ts': 'export const lib = 1;\n',
      'packages/pkg/test/index.ts': 'export const test = 1;\n',
      'packages/pkg/tsconfig.lib.dts.json': JSON.stringify({
        extends: './tsconfig.lib.json',
        compilerOptions: {
          composite: true,
          declaration: true,
          emitDeclarationOnly: true,
          noEmit: false,
          outDir: './.tsbuild/lib',
          tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
        },
        liminaOptions: {
          sourceConfig: './tsconfig.lib.json',
        },
      }),
      'packages/pkg/tsconfig.lib.json': JSON.stringify({
        compilerOptions: {
          lib: ['ES2023'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: [
          '__typings__/index.d.ts',
          '__typings__/local.d.ts',
          '__typings__/typed.d.ts',
          'src/lib.ts',
        ],
      }),
      'packages/pkg/tsconfig.test.dts.json': JSON.stringify({
        extends: './tsconfig.test.json',
        compilerOptions: {
          composite: true,
          declaration: true,
          emitDeclarationOnly: true,
          noEmit: false,
          outDir: './.tsbuild/test',
          tsBuildInfoFile: './.tsbuild/test.tsbuildinfo',
        },
        liminaOptions: {
          sourceConfig: './tsconfig.test.json',
        },
      }),
      'packages/pkg/tsconfig.test.json': JSON.stringify({
        compilerOptions: {
          lib: ['ES2023'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: [
          '__typings__/index.d.ts',
          '__typings__/local.d.ts',
          '__typings__/typed.d.ts',
          'test/index.ts',
        ],
      }),
      'packages/pkg/tsconfig.json': JSON.stringify({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
          {
            path: './tsconfig.test.json',
          },
        ],
      }),
      'tsconfig.json': JSON.stringify({
        files: [],
        references: [
          {
            path: './packages/pkg/tsconfig.json',
          },
        ],
      }),
    });
    const issues: LiminaCheckIssue[] = [];

    try {
      await expect(
        runProofCheck(fixture.config, {
          deferSnapshot: true,
          generatedGraphProvider: async () =>
            createCheckerGraphCoverageProofGeneratedGraph(fixture.rootDir),
          issues,
          report: {
            defer: true,
          },
        }),
      ).resolves.toBe(true);

      for (const filePath of [
        'packages/pkg/__typings__/index.d.ts',
        'packages/pkg/__typings__/local.d.ts',
        'packages/pkg/__typings__/typed.d.ts',
      ]) {
        expect(issues).not.toContainEqual(
          expect.objectContaining({
            filePath,
            title: 'Duplicate checker graph coverage',
          }),
        );
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores inert build graph aggregators with source inputs or compilerOptions', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'tsconfig.build.json': JSON.stringify({
          compilerOptions: {
            strict: true,
          },
          files: [],
          include: ['packages/pkg/src/**/*.ts'],
          references: [
            {
              path: './packages/pkg/tsconfig.lib.dts.json',
            },
          ],
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores inert dts leaves without declaration emit semantics', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/tsconfig.lib.dts.json': JSON.stringify({
          extends: './tsconfig.json',
          compilerOptions: {
            composite: true,
            noEmit: false,
            outDir: './.tsbuild',
            rootDir: 'src',
            tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
          },
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores inert multi-environment directories outside managed entries', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/tsconfig.lib.dts.json': JSON.stringify({
          extends: './tsconfig.lib.json',
          compilerOptions: {
            composite: true,
            declaration: true,
            emitDeclarationOnly: true,
            noEmit: false,
            outDir: './.tsbuild',
            rootDir: 'src',
            tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
          },
        }),
        'packages/pkg/tsconfig.lib.json': JSON.stringify({
          compilerOptions: {
            lib: ['ES2023'],
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['src/**/*.ts'],
        }),
        'packages/pkg/tsconfig.test.json': JSON.stringify({
          compilerOptions: {
            lib: ['ES2023'],
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['src/**/*.ts'],
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects default source tsconfig files that still declare project references', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'base.json': JSON.stringify({}),
        'tsconfig.json': JSON.stringify({
          extends: './base.json',
          compilerOptions: {
            noEmit: true,
          },
          files: ['packages/pkg/src/index.ts'],
          include: ['packages/pkg/src/**/*.ts'],
          references: [
            {
              path: './packages/pkg/tsconfig.json',
            },
          ],
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).rejects.toThrow(
        'Source typecheck config declares project references',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports missing local typecheck config files', async () => {
    const files = createPassingFiles();
    delete files['packages/pkg/tsconfig.json'];
    const fixture = await createFixture(files);

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores inert dts compiler option drift from the local typecheck config', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/tsconfig.lib.dts.json': JSON.stringify({
          extends: './tsconfig.json',
          compilerOptions: {
            composite: true,
            lib: ['ES2020'],
            moduleResolution: 'node10',
            noEmit: false,
            outDir: './.tsbuild',
            strict: false,
            tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
            types: ['node'],
          },
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores relative import rewrite drift in declaration-only configs', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/tsconfig.json': JSON.stringify({
          compilerOptions: {
            allowImportingTsExtensions: true,
            lib: ['ES2023'],
            module: 'ESNext',
            moduleResolution: 'bundler',
            noEmit: true,
            rewriteRelativeImportExtensions: true,
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['src/**/*.ts'],
        }),
        'packages/pkg/tsconfig.lib.dts.json': JSON.stringify({
          extends: './tsconfig.json',
          compilerOptions: {
            composite: true,
            declaration: true,
            emitDeclarationOnly: true,
            noEmit: false,
            outDir: './.tsbuild',
            rewriteRelativeImportExtensions: false,
            rootDir: 'src',
            tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
          },
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores inert declaration-only compiler option extensions', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/tsconfig.lib.dts.json': JSON.stringify({
          extends: './tsconfig.json',
          compilerOptions: {
            composite: true,
            declaration: true,
            declarationMap: false,
            emitDeclarationOnly: true,
            incremental: true,
            noEmit: false,
            outDir: './.tsbuild',
            rootDir: 'src',
            sourceMap: false,
            tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
          },
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores inert dts and local file set drift', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/src/extra.ts': 'export const extra = 2;\n',
        'packages/pkg/tsconfig.lib.dts.json': JSON.stringify({
          extends: './tsconfig.json',
          compilerOptions: {
            composite: true,
            noEmit: false,
            outDir: './.tsbuild',
            tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
          },
          include: ['src/index.ts'],
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores inert paths and baseUrl drift because module resolution is checked by graph validation', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/tsconfig.lib.dts.json': JSON.stringify({
          extends: './tsconfig.json',
          compilerOptions: {
            baseUrl: '.',
            composite: true,
            declaration: true,
            emitDeclarationOnly: true,
            noEmit: false,
            outDir: './.tsbuild',
            paths: {
              '#internal/*': ['./src/*'],
            },
            tsBuildInfoFile: './.tsbuild/lib.tsbuildinfo',
          },
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects declaration configs referenced from default typecheck aggregators', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/tsconfig.json': JSON.stringify({
          files: [],
          references: [
            {
              path: './tsconfig.lib.dts.json',
            },
          ],
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects single-environment directories that keep a scoped local config', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/tsconfig.json': JSON.stringify({
          files: [],
          references: [
            {
              path: './tsconfig.lib.json',
            },
          ],
        }),
        'packages/pkg/tsconfig.lib.json': JSON.stringify({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['src/**/*.ts'],
        }),
      }),
    );

    try {
      const result = await collectTypedProofFindings(fixture.config);
      const finding = requireProofFinding(
        result.findings,
        LIMINA_CHECK_ISSUE_CODES.proofDefaultTsconfigInvalid,
      );

      expect(result.passed).toBe(false);
      expect(finding).toMatchObject({
        code: LIMINA_CHECK_ISSUE_CODES.proofDefaultTsconfigInvalid,
        facts: {
          defaultConfigPath: toPortablePath(
            path.join(fixture.rootDir, 'packages/pkg/tsconfig.json'),
          ),
          directoryPath: toPortablePath(
            path.join(fixture.rootDir, 'packages/pkg'),
          ),
          environmentConfigPaths: [
            toPortablePath(
              path.join(fixture.rootDir, 'packages/pkg/tsconfig.lib.json'),
            ),
          ],
          kind: 'environment-layout',
          violation: 'single-environment-uses-named-config',
        },
        task: 'proof:check',
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores inert duplicate same-family checker build owners', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/tsconfig.alt.dts.json': JSON.stringify({
          extends: './tsconfig.json',
          compilerOptions: {
            composite: true,
            declaration: true,
            emitDeclarationOnly: true,
            noEmit: false,
            outDir: './.tsbuild',
            rootDir: 'src',
            tsBuildInfoFile: './.tsbuild/alt.tsbuildinfo',
          },
        }),
        'tsconfig.alt.build.json': JSON.stringify({
          files: [],
          references: [
            {
              path: './packages/pkg/tsconfig.alt.dts.json',
            },
          ],
        }),
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            checkers: {
              tsc: {
                include: ['tsconfig.json'],
              },
              tsgo: {
                include: ['tsconfig.alt.json'],
              },
            },
          },
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects incompatible declared constraints across nested solutions', async () => {
    const fixture = await createFixture({
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/tsconfig.test.dts.json': JSON.stringify({
        extends: './tsconfig.test.json',
        compilerOptions: {
          composite: true,
          declaration: true,
          emitDeclarationOnly: true,
          noEmit: false,
          outDir: './.tsbuild',
          tsBuildInfoFile: './.tsbuild/test.tsbuildinfo',
        },
      }),
      'packages/pkg/tsconfig.test.json': JSON.stringify({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/pkg/tsconfig.sfc.json': JSON.stringify({
        extends: './tsconfig.test.json',
      }),
      'packages/pkg/tsconfig.sfc.dts.json': JSON.stringify({
        extends: './tsconfig.sfc.json',
        compilerOptions: {
          composite: true,
          declaration: true,
          emitDeclarationOnly: true,
          noEmit: false,
          outDir: './.tsbuild',
          tsBuildInfoFile: './.tsbuild/vue.tsbuildinfo',
        },
      }),
      'packages/pkg/tsconfig.json': JSON.stringify({
        files: [],
        references: [
          {
            path: './tsconfig.test.json',
          },
        ],
      }),
      'tsconfig.json': JSON.stringify({
        files: [],
        references: [
          {
            path: './packages/pkg/tsconfig.json',
          },
        ],
      }),
      'tsconfig.build.json': JSON.stringify({
        files: [],
        references: [
          {
            path: './packages/pkg/tsconfig.test.dts.json',
          },
        ],
      }),
    });

    try {
      const config: ResolvedLiminaConfig = {
        ...fixture.config,
        config: {
          ...fixture.config.config,
          checkers: {
            tsc: {
              include: ['tsconfig.json'],
            },
            'vue-tsc': {
              include: ['packages/pkg/tsconfig.json'],
            },
          },
        },
      };
      await expect(
        prepareAndMaterializeGeneratedTsconfigGraph(config),
      ).rejects.toThrow(
        /Checker ownership conflict[\s\S]*checker: tsc[\s\S]*checker: vue-tsc/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports missing configured checker entry configs', async () => {
    const fixture = await createFixture(createPassingFiles());

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            checkers: {
              ...(typeof fixture.config.config?.checkers === 'object'
                ? fixture.config.config.checkers
                : {}),
              'vue-tsc': {
                include: ['packages/pkg/tsconfig.missing.json'],
              },
            },
          },
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports source files outside checker entries and allowlist coverage', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/fixtures/uncovered.ts': 'export const uncovered = 1;\n',
      }),
    );

    try {
      const result = await collectTypedProofFindings(fixture.config);
      const finding = requireProofFinding(
        result.findings,
        LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile,
      );

      expect(result.passed).toBe(false);
      expect(finding).toMatchObject({
        code: LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile,
        facts: {
          candidateCheckerNames: ['tsc'],
          candidateProjectPaths: expect.any(Array),
          configuredSourceExcludes: [],
          configuredSourceIncludes: ['...'],
          coverage: [],
          kind: 'no-checker-or-allowlist-coverage',
          sourcePath: toPortablePath(
            path.join(fixture.rootDir, 'packages/pkg/fixtures/uncovered.ts'),
          ),
        },
        filePath: toPortablePath(
          path.join(fixture.rootDir, 'packages/pkg/fixtures/uncovered.ts'),
        ),
        hint: expect.any(String),
        packageName: '@fixture/pkg',
        task: 'proof:check',
      });

      await expect(runProofCheck(fixture.config)).resolves.toBe(false);

      const snapshot = await readCheckIssueSnapshot(fixture.rootDir);

      expect(snapshot?.issues).toContainEqual(
        expect.objectContaining({
          code: 'LIMINA_PROOF_UNCOVERED_SOURCE_FILE',
          filePath: 'packages/pkg/fixtures/uncovered.ts',
          fix: finding.hint,
          locations: [
            {
              filePath: 'packages/pkg/fixtures/uncovered.ts',
              label: 'uncovered source',
            },
          ],
          reason: finding.reason,
          scope: 'packages/pkg/fixtures',
          task: 'proof:check',
          title: 'Source file is not covered by typecheck proof',
        }),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports fixed default source extensions outside checker coverage', async () => {
    const errorSpy = vi
      .spyOn(ProofLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/fixtures/config.mjs': 'export default {};\n',
        'packages/pkg/fixtures/data.json': JSON.stringify({ ok: true }),
        'packages/pkg/fixtures/ignored.cjs': 'exports.value = 1;\n',
        'packages/pkg/fixtures/ignored.js': 'export const value = 1;\n',
        'packages/pkg/fixtures/ignored.jsx': 'export const value = <div />;\n',
        'packages/pkg/fixtures/ignored.svelte':
          '<script>const value = 1;</script>\n',
        'packages/pkg/fixtures/ignored.vue':
          '<script setup lang="ts">const value = 1;</script>\n',
        'packages/pkg/fixtures/uncovered.cts': 'export const value = 1;\n',
        'packages/pkg/fixtures/uncovered.d.cts':
          'export declare const value: number;\n',
        'packages/pkg/fixtures/uncovered.d.mts':
          'export declare const value: number;\n',
        'packages/pkg/fixtures/uncovered.d.ts':
          'export declare const value: number;\n',
        'packages/pkg/fixtures/uncovered.mts': 'export const value = 1;\n',
        'packages/pkg/fixtures/uncovered.ts': 'export const value = 1;\n',
        'packages/pkg/fixtures/uncovered.tsx':
          'export const value = <div />;\n',
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(false);
      const snapshot = await readCheckIssueSnapshot(fixture.rootDir);
      const issueFiles = snapshot?.issues.map((issue) => issue.filePath);

      expect(issueFiles).toEqual(
        expect.arrayContaining([
          'packages/pkg/fixtures/uncovered.cts',
          'packages/pkg/fixtures/uncovered.d.cts',
          'packages/pkg/fixtures/uncovered.d.mts',
          'packages/pkg/fixtures/uncovered.d.ts',
          'packages/pkg/fixtures/uncovered.mts',
          'packages/pkg/fixtures/uncovered.ts',
          'packages/pkg/fixtures/uncovered.tsx',
        ]),
      );
      expect(issueFiles).not.toContain('packages/pkg/fixtures/config.mjs');
      expect(issueFiles).not.toContain('packages/pkg/fixtures/data.json');
      expect(issueFiles).not.toContain('packages/pkg/fixtures/ignored.cjs');
      expect(issueFiles).not.toContain('packages/pkg/fixtures/ignored.js');
      expect(issueFiles).not.toContain('packages/pkg/fixtures/ignored.jsx');
      expect(issueFiles).not.toContain('packages/pkg/fixtures/ignored.svelte');
      expect(issueFiles).not.toContain('packages/pkg/fixtures/ignored.vue');
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('reports Vue and Svelte files outside an explicit Astro owner observation set', async () => {
    const fixture = await createFixture({
      'packages/app/src/component.svelte': '<h1>Svelte</h1>\n',
      'packages/app/src/component.vue': '<template><h1>Vue</h1></template>\n',
      'packages/app/src/index.ts': 'export const value = 1;\n',
      'packages/app/src/page.astro': '<h1>Astro</h1>\n',
      'packages/app/.astro/types.d.ts': 'declare module "astro:content" {}\n',
      'packages/app/package.json': JSON.stringify({
        devDependencies: {
          '@astrojs/check': '0.9.10',
          astro: '7.2.0',
          typescript: '6.0.3',
        },
        name: '@fixture/app',
        private: true,
      }),
      'packages/app/tsconfig.json': JSON.stringify({
        include: ['src/**/*'],
      }),
    });

    try {
      for (const [installedName, packageName] of [
        ['astro-v7-current', 'astro'],
        ['@astrojs/check', '@astrojs/check'],
      ] as const) {
        const targetPath = path.join(
          fixture.rootDir,
          'packages/app/node_modules',
          packageName,
        );
        await mkdir(path.dirname(targetPath), { recursive: true });
        await symlink(
          resolveInstalledPackageRoot(installedName, packageName),
          targetPath,
          'junction',
        );
      }
      const config: ResolvedLiminaConfig = {
        ...fixture.config,
        config: {
          checkers: {
            astro: {
              include: ['packages/app/tsconfig.json'],
            },
          },
          source: {
            include: ['packages/app/src/**/*'],
          },
        },
      };
      const graph = await prepareAndMaterializeGeneratedTsconfigGraph(config);
      expect(
        [...(graph.governedSources.get('astro')?.values() ?? [])].flatMap(
          (source) =>
            source.ownedFileNames.map((filePath) => path.basename(filePath)),
        ),
      ).toEqual(['index.ts', 'page.astro']);
      const result = await collectProofIssues(config);
      const uncoveredFiles = collectUncoveredSourceIssueFiles(result.issues);

      expect(result.passed).toBe(false);
      expect(uncoveredFiles).toEqual([
        'packages/app/src/component.svelte',
        'packages/app/src/component.vue',
      ]);
      expect(uncoveredFiles).not.toContain('packages/app/src/index.ts');
      expect(uncoveredFiles).not.toContain('packages/app/src/page.astro');
    } finally {
      await fixture.cleanup();
    }
  });

  it('expands source include default token exactly like omitted source include at runtime', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/fixtures/config.mjs': 'export default {};\n',
        'packages/pkg/fixtures/data.json': JSON.stringify({ ok: true }),
        'packages/pkg/fixtures/ignored.svelte':
          '<script>const value = 1;</script>\n',
        'packages/pkg/fixtures/ignored.vue':
          '<script setup lang="ts">const value = 1;</script>\n',
        'packages/pkg/fixtures/uncovered.d.mts':
          'export declare const value: number;\n',
        'packages/pkg/fixtures/uncovered.ts': 'export const value = 1;\n',
        'packages/pkg/fixtures/uncovered.tsx':
          'export const value = <div />;\n',
      }),
    );

    try {
      const omitted = await collectProofIssues(fixture.config);
      const ellipsis = await collectProofIssues({
        ...fixture.config,
        config: {
          ...fixture.config.config,
          source: {
            include: ['...'],
          },
        },
      });
      const ellipsisFiles = collectUncoveredSourceIssueFiles(ellipsis.issues);

      expect(omitted.passed).toBe(false);
      expect(ellipsis.passed).toBe(false);
      expect(ellipsisFiles).toEqual(
        collectUncoveredSourceIssueFiles(omitted.issues),
      );
      expect(ellipsisFiles).toEqual(
        expect.arrayContaining([
          'packages/pkg/fixtures/uncovered.d.mts',
          'packages/pkg/fixtures/uncovered.ts',
          'packages/pkg/fixtures/uncovered.tsx',
        ]),
      );
      expect(ellipsisFiles).not.toContain('packages/pkg/fixtures/config.mjs');
      expect(ellipsisFiles).not.toContain('packages/pkg/fixtures/data.json');
      expect(ellipsisFiles).not.toContain(
        'packages/pkg/fixtures/ignored.svelte',
      );
      expect(ellipsisFiles).not.toContain('packages/pkg/fixtures/ignored.vue');
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses root gitignore patterns in the default source exclude', async () => {
    const errorSpy = vi
      .spyOn(ProofLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture(
      createPassingFiles({
        '.gitignore': 'ignored-default/*.ts\n!ignored-default/keep.ts\n',
        'ignored-default/hidden.ts': 'export const hidden = 1;\n',
        'ignored-default/keep.ts': 'export const keep = 1;\n',
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            source: {
              include: ['ignored-default/*.ts'],
            },
          },
        }),
      ).resolves.toBe(false);
      const output = errorSpy.mock.calls.join('\n');

      expect(output).toContain('ignored-default/keep.ts');
      expect(output).not.toContain('ignored-default/hidden.ts');
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('expands source exclude default token exactly like omitted source exclude at runtime', async () => {
    const includedPaths = [
      'packages/pkg/src/**/*.ts',
      'bower_components/**/*.ts',
      'ignored-default/*.ts',
      'jspm_packages/**/*.ts',
      'node_modules/**/*.ts',
      'packages/pkg/dist/**/*.ts',
      'packages/other/dist/**/*.ts',
    ];
    const fixture = await createFixture(
      createPassingFiles({
        '.gitignore': 'ignored-default/*.ts\n!ignored-default/keep.ts\n',
        'bower_components/uncovered.ts': 'export const value = 1;\n',
        'ignored-default/hidden.ts': 'export const hidden = 1;\n',
        'ignored-default/keep.ts': 'export const keep = 1;\n',
        'jspm_packages/uncovered.ts': 'export const value = 1;\n',
        'node_modules/uncovered.ts': 'export const value = 1;\n',
        'packages/other/dist/uncovered.ts': 'export const value = 1;\n',
        'packages/pkg/dist/uncovered.ts': 'export const value = 1;\n',
        'packages/pkg/tsconfig.json': JSON.stringify({
          compilerOptions: {
            lib: ['ES2023'],
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['src/**/*.ts'],
          liminaOptions: {
            outputs: {
              outDir: 'dist',
            },
          },
        }),
      }),
    );

    try {
      const omitted = await collectProofIssues({
        ...fixture.config,
        config: {
          ...fixture.config.config,
          source: {
            include: includedPaths,
          },
        },
      });
      const ellipsis = await collectProofIssues({
        ...fixture.config,
        config: {
          ...fixture.config.config,
          source: {
            exclude: ['...'],
            include: includedPaths,
          },
        },
      });
      const ellipsisFiles = collectUncoveredSourceIssueFiles(ellipsis.issues);

      expect(omitted.passed).toBe(false);
      expect(ellipsis.passed).toBe(false);
      expect(ellipsisFiles).toEqual(
        collectUncoveredSourceIssueFiles(omitted.issues),
      );
      expect(ellipsisFiles).toEqual(
        expect.arrayContaining([
          'ignored-default/keep.ts',
          'packages/other/dist/uncovered.ts',
        ]),
      );
      expect(ellipsisFiles).not.toContain('bower_components/uncovered.ts');
      expect(ellipsisFiles).not.toContain('ignored-default/hidden.ts');
      expect(ellipsisFiles).not.toContain('jspm_packages/uncovered.ts');
      expect(ellipsisFiles).not.toContain('node_modules/uncovered.ts');
      expect(ellipsisFiles).not.toContain('packages/pkg/dist/uncovered.ts');
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not use default source excludes when source exclude is configured without default token', async () => {
    const errorSpy = vi
      .spyOn(ProofLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture(
      createPassingFiles({
        '.gitignore': 'ignored-default/*.ts\n',
        'bower_components/uncovered.ts': 'export const value = 1;\n',
        'custom-ignore/hidden.ts': 'export const hidden = 1;\n',
        'ignored-default/hidden.ts': 'export const hidden = 1;\n',
        'jspm_packages/uncovered.ts': 'export const value = 1;\n',
        'packages/pkg/dist/uncovered.ts': 'export const value = 1;\n',
        'packages/pkg/tsconfig.json': JSON.stringify({
          compilerOptions: {
            lib: ['ES2023'],
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['src/**/*.ts'],
          liminaOptions: {
            outputs: {
              outDir: 'dist',
            },
          },
        }),
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            source: {
              exclude: ['custom-ignore/**'],
              include: [
                'packages/pkg/src/**/*.ts',
                'bower_components/**/*.ts',
                'custom-ignore/**/*.ts',
                'ignored-default/*.ts',
                'jspm_packages/**/*.ts',
                'packages/pkg/dist/**/*.ts',
              ],
            },
          },
        }),
      ).resolves.toBe(false);
      const output = errorSpy.mock.calls.join('\n');

      expect(output).toContain('bower_components/uncovered.ts');
      expect(output).toContain('ignored-default/hidden.ts');
      expect(output).toContain('jspm_packages/uncovered.ts');
      expect(output).toContain('packages/pkg/dist/uncovered.ts');
      expect(output).not.toContain('custom-ignore/hidden.ts');
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('expands default source exclude bundle when source exclude includes default token', async () => {
    const errorSpy = vi
      .spyOn(ProofLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture(
      createPassingFiles({
        '.gitignore': 'ignored-default/*.ts\n!ignored-default/keep.ts\n',
        'custom-ignore/hidden.ts': 'export const hidden = 1;\n',
        'ignored-default/hidden.ts': 'export const hidden = 1;\n',
        'ignored-default/keep.ts': 'export const keep = 1;\n',
        'node_modules/uncovered.ts': 'export const value = 1;\n',
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            source: {
              exclude: ['...', 'custom-ignore/**'],
              include: [
                'packages/pkg/src/**/*.ts',
                'custom-ignore/**/*.ts',
                'ignored-default/*.ts',
                'node_modules/**/*.ts',
              ],
            },
          },
        }),
      ).resolves.toBe(false);
      const output = errorSpy.mock.calls.join('\n');

      expect(output).toContain('ignored-default/keep.ts');
      expect(output).not.toContain('custom-ignore/hidden.ts');
      expect(output).not.toContain('ignored-default/hidden.ts');
      expect(output).not.toContain('node_modules/uncovered.ts');
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('normalizes source exclude directory shorthands after default token expansion', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/fixtures/uncovered.ts': 'export const value = 1;\n',
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            source: {
              exclude: ['...', 'fixtures'],
              include: [
                'packages/pkg/src/**/*.ts',
                'packages/pkg/fixtures/**/*.ts',
              ],
            },
          },
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('applies dependency and explicit output source excludes when source exclude is omitted', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'bower_components/uncovered.ts': 'export const value = 1;\n',
        'coverage/uncovered.ts': 'export const value = 1;\n',
        'dist/uncovered.ts': 'export const value = 1;\n',
        'jspm_packages/uncovered.ts': 'export const value = 1;\n',
        'node_modules/uncovered.ts': 'export const value = 1;\n',
        'packages/pkg/dist/uncovered.ts': 'export const value = 1;\n',
        'packages/pkg/tsconfig.json': JSON.stringify({
          compilerOptions: {
            lib: ['ES2023'],
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['src/**/*.ts'],
          liminaOptions: {
            outputs: {
              outDir: 'dist',
            },
          },
        }),
      }),
    );

    try {
      const result = await collectProofIssues({
        ...fixture.config,
        config: {
          ...fixture.config.config,
          source: {
            include: [
              'packages/pkg/src/**/*.ts',
              'bower_components/**/*.ts',
              'coverage/**/*.ts',
              'dist/**/*.ts',
              'jspm_packages/**/*.ts',
              'node_modules/**/*.ts',
              'packages/pkg/dist/**/*.ts',
            ],
          },
        },
      });
      const issueFiles = collectUncoveredSourceIssueFiles(result.issues);

      expect(result.passed).toBe(false);
      expect(issueFiles).toEqual(
        expect.arrayContaining(['coverage/uncovered.ts', 'dist/uncovered.ts']),
      );
      expect(issueFiles).not.toContain('bower_components/uncovered.ts');
      expect(issueFiles).not.toContain('jspm_packages/uncovered.ts');
      expect(issueFiles).not.toContain('node_modules/uncovered.ts');
      expect(issueFiles).not.toContain('packages/pkg/dist/uncovered.ts');
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports tsconfig-covered files outside the configured source boundary', async () => {
    const errorSpy = vi
      .spyOn(ProofLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/fixtures/covered.ts': 'export const covered = 1;\n',
        'packages/pkg/tsconfig.json': JSON.stringify({
          compilerOptions: {
            lib: ['ES2023'],
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['src/**/*.ts', 'fixtures/**/*.ts'],
        }),
      }),
    );
    const config = {
      ...fixture.config,
      config: {
        ...fixture.config.config,
        source: {
          include: ['packages/pkg/src/**/*.ts'],
        },
      },
    };

    try {
      const result = await collectTypedProofFindings(config);
      const finding = requireProofFinding(
        result.findings,
        LIMINA_CHECK_ISSUE_CODES.proofSourceBoundaryMismatch,
      );

      expect(result.passed).toBe(false);
      expect(finding).toMatchObject({
        code: LIMINA_CHECK_ISSUE_CODES.proofSourceBoundaryMismatch,
        facts: {
          configuredSourceExcludes: [],
          configuredSourceIncludes: ['packages/pkg/src/**/*.ts'],
          kind: 'coverage-outside-source-boundary',
          repositoryRoot: toPortablePath(fixture.rootDir),
          sources: expect.arrayContaining([
            {
              coverage: expect.arrayContaining([
                expect.objectContaining({ type: 'graph' }),
                expect.objectContaining({ type: 'checker' }),
              ]),
              sourcePath: toPortablePath(
                path.join(fixture.rootDir, 'packages/pkg/fixtures/covered.ts'),
              ),
              packageManifestPath: toPortablePath(
                path.join(fixture.rootDir, 'packages/pkg/package.json'),
              ),
              packageName: '@fixture/pkg',
              packageRoot: toPortablePath(
                path.join(fixture.rootDir, 'packages/pkg'),
              ),
            },
          ]),
        },
        hint: expect.any(String),
        task: 'proof:check',
      });

      await expect(runProofCheck(config)).resolves.toBe(false);
      expect(errorSpy.mock.calls.join('\n')).toContain(
        'Typecheck proof source boundary does not match tsconfig coverage',
      );
      expect(errorSpy.mock.calls.join('\n')).toContain(
        'packages/pkg/fixtures/covered.ts',
      );
      expect(errorSpy.mock.calls.join('\n')).toContain(
        'config.source and tsconfig*.json coverage describe different module sets',
      );
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('accepts JavaScript files included by the checker parsed project', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'tools/eslint.config.mjs': 'export default [];\n',
        'tools/tsconfig.json': JSON.stringify({
          compilerOptions: {
            allowJs: true,
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['eslint.config.mjs'],
        }),
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            source: {
              include: ['packages/pkg/src/**/*.ts', 'tools/eslint.config.mjs'],
            },
          },
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not govern MJS files by default', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'tools/eslint.config.mjs': 'export default [];\n',
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports checker-covered MJS files outside the default source boundary', async () => {
    const errorSpy = vi
      .spyOn(ProofLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture(
      createPassingFiles({
        'tools/eslint.config.mjs': 'export default [];\n',
        'tools/tsconfig.json': JSON.stringify({
          compilerOptions: {
            allowJs: true,
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['eslint.config.mjs'],
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(false);
      const output = errorSpy.mock.calls.join('\n');

      expect(output).toContain(
        'Typecheck proof source boundary does not match tsconfig coverage',
      );
      expect(output).toContain('tools/eslint.config.mjs');
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('reports JavaScript config files outside checker and allowlist coverage', async () => {
    const errorSpy = vi
      .spyOn(ProofLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture(
      createPassingFiles({
        'eslint.config.mjs': 'export default [];\n',
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            source: {
              include: ['packages/pkg/src/**/*.ts', 'eslint.config.mjs'],
            },
          },
        }),
      ).resolves.toBe(false);
      expect(errorSpy.mock.calls.join('\n')).toContain(
        'Source file is not covered by typecheck proof',
      );
      expect(errorSpy.mock.calls.join('\n')).toContain('eslint.config.mjs');
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('uses explicit source include as the complete source boundary', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'docs/page.md': '# page\n',
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            source: {
              include: ['docs/*.md'],
            },
          },
        }),
      ).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not let source include pull files from nested workspace regions', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/fixture/pnpm-workspace.yaml': 'packages: []\n',
        'packages/pkg/fixture/src/uncovered.ts': 'export const value = 1;\n',
      }),
    );

    try {
      const result = await collectProofIssues({
        ...fixture.config,
        config: {
          ...fixture.config.config,
          source: {
            include: [
              'packages/pkg/src/**/*.ts',
              'packages/pkg/fixture/**/*.ts',
            ],
          },
        },
      });

      expect(result.passed).toBe(true);
      expect(collectUncoveredSourceIssueFiles(result.issues)).not.toContain(
        'packages/pkg/fixture/src/uncovered.ts',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('governs root source files when the root package is activated', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'random/unowned.ts': 'export const value = 1;\n',
      }),
    );

    try {
      const result = await collectProofIssues(fixture.config);

      expect(result.passed).toBe(false);
      expect(collectUncoveredSourceIssueFiles(result.issues)).toContain(
        'random/unowned.ts',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not govern root source files when the current package set excludes the root package', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'random/unowned.ts': 'export const value = 1;\n',
      }),
    );

    try {
      const sourceFiles = await collectExpectedSourceFiles(
        fixture.config,
        createCheckerGraphCoverageProofGeneratedGraph(fixture.rootDir),
        await collectValidatedWorkspaceContext({
          config: fixture.config,
          rawPackages: [
            {
              directory: path.join(fixture.rootDir, 'packages/pkg'),
              manifest: {
                name: '@fixture/pkg',
                private: true,
              },
              name: '@fixture/pkg',
            },
          ],
        }),
      );

      expect(
        [...sourceFiles].map((filePath) =>
          path.relative(fixture.rootDir, filePath),
        ),
      ).not.toContain('random/unowned.ts');
    } finally {
      await fixture.cleanup();
    }
  });

  it('filters external island candidates with ../ selectors without applying root .gitignore', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        '.gitignore': '**/*.ts\n',
      }),
    );
    const externalRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-proof-external-')),
    );
    const externalSourcePath = path.join(externalRoot, 'src/index.ts');
    await writeText(
      path.join(externalRoot, 'package.json'),
      stringifyConfig({ name: '@fixture/external', private: true }),
    );
    await writeText(externalSourcePath, 'export const value = 1;\n');
    const externalPattern = `${path
      .relative(fixture.rootDir, externalRoot)
      .split(path.sep)
      .join('/')}/src/**/*.ts`;
    const config: ResolvedLiminaConfig = {
      ...fixture.config,
      config: {
        ...fixture.config.config,
        source: { include: [externalPattern] },
      },
    };

    try {
      const context = await collectValidatedWorkspaceContext({
        config,
        rawPackages: [
          {
            directory: externalRoot,
            manifest: { name: '@fixture/external', private: true },
            name: '@fixture/external',
          },
        ],
      });
      const sourceFiles = await collectExpectedSourceFiles(
        config,
        createCheckerGraphCoverageProofGeneratedGraph(fixture.rootDir),
        context,
      );

      expect(sourceFiles.has(toPortablePath(externalSourcePath))).toBe(true);
    } finally {
      await Promise.all([
        fixture.cleanup(),
        rm(externalRoot, { force: true, recursive: true }),
      ]);
    }
  });

  it('keeps explicit root source include inside the activated root package', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'random/unowned.ts': 'export const value = 1;\n',
      }),
    );

    try {
      const result = await collectProofIssues({
        ...fixture.config,
        config: {
          ...fixture.config.config,
          source: {
            include: ['random/**/*.ts'],
          },
        },
      });

      expect(result.passed).toBe(false);
      expect(collectUncoveredSourceIssueFiles(result.issues)).toContain(
        'random/unowned.ts',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses explicit JSON source include as a replacement boundary', async () => {
    const errorSpy = vi
      .spyOn(ProofLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/fixtures/data.json': JSON.stringify({ ok: true }),
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            source: {
              include: ['**/*.json'],
            },
          },
        }),
      ).resolves.toBe(false);
      const output = errorSpy.mock.calls.join('\n');

      expect(output).toContain('packages/pkg/fixtures/data.json');
      expect(output).toContain('packages/pkg/src/index.ts');
      expect(output).toContain(
        'Typecheck proof source boundary does not match tsconfig coverage',
      );
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('expands default source include when source include contains default token', async () => {
    const errorSpy = vi
      .spyOn(ProofLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/fixtures/config.mjs': 'export default {};\n',
        'packages/pkg/fixtures/data.json': JSON.stringify({ ok: true }),
        'packages/pkg/fixtures/uncovered.ts': 'export const value = 1;\n',
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            source: {
              include: ['...', '**/*.json', '**/*.mjs'],
            },
          },
        }),
      ).resolves.toBe(false);
      const output = errorSpy.mock.calls.join('\n');

      expect(output).toContain('packages/pkg/fixtures/config.mjs');
      expect(output).toContain('packages/pkg/fixtures/data.json');
      expect(output).toContain('packages/pkg/fixtures/uncovered.ts');
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('reports allowlist entries outside the configured source boundary', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/fixtures/ignored.md': 'not part of source proof\n',
      }),
    );
    const config = {
      ...fixture.config,
      proof: {
        allowlist: [
          {
            file: 'packages/pkg/fixtures/ignored.md',
            reason: 'markdown files are outside proof source boundary',
          },
        ],
      },
    };

    try {
      const result = await collectTypedProofFindings(config);
      const finding = requireProofFinding(
        result.findings,
        LIMINA_CHECK_ISSUE_CODES.proofAllowlistInvalid,
      );

      expect(result.passed).toBe(false);
      expect(finding).toMatchObject({
        code: LIMINA_CHECK_ISSUE_CODES.proofAllowlistInvalid,
        facts: {
          configuredPath: 'packages/pkg/fixtures/ignored.md',
          coverage: [],
          kind: 'entry-coverage',
          repositoryRoot: toPortablePath(fixture.rootDir),
          resolvedPath: toPortablePath(
            path.join(fixture.rootDir, 'packages/pkg/fixtures/ignored.md'),
          ),
          ruleIndex: 0,
          sourcePath: toPortablePath(
            path.join(fixture.rootDir, 'packages/pkg/fixtures/ignored.md'),
          ),
          violation: 'outside-source-boundary',
        },
        task: 'proof:check',
      });

      await expect(runProofCheck(config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts source files covered by the proof allowlist', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'packages/pkg/fixtures/allowed.ts': 'export const allowed = 1;\n',
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          proof: {
            allowlist: [
              {
                file: 'packages/pkg/fixtures/allowed.ts',
                reason:
                  'fixture intentionally lives outside TypeScript entries',
              },
            ],
          },
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports checker-covered Vue source files outside the default source boundary', async () => {
    const errorSpy = vi
      .spyOn(ProofLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture(
      createPassingFiles({
        'tools/covered.vue':
          '<script setup lang="ts">const value = 1;</script>\n',
        'tools/tsconfig.json': JSON.stringify({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['covered.vue'],
        }),
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            checkers: {
              tsc: {
                exclude: ['**/tsconfig*.dts.json', '**/tsconfig*.build.json'],
                include: ['packages/pkg/tsconfig.json'],
              },
              'vue-tsc': {
                include: ['tools/tsconfig.json'],
              },
            },
          },
        }),
      ).resolves.toBe(false);
      const output = errorSpy.mock.calls.join('\n');

      expect(output).toContain(
        'Typecheck proof source boundary does not match tsconfig coverage',
      );
      expect(output).toContain('tools/covered.vue');
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('does not include unchecked Vue files in the default source boundary', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'tools/covered.ts': 'export const value = 1;\n',
        'tools/tsconfig.json': JSON.stringify({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['covered.ts'],
        }),
        'tools/uncovered.vue':
          '<script setup lang="ts">const value = 2;</script>\n',
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            checkers: {
              tsc: {
                exclude: ['**/tsconfig*.dts.json', '**/tsconfig*.build.json'],
                include: ['packages/pkg/tsconfig.json'],
              },
              'vue-tsc': {
                include: ['tools/tsconfig.json'],
              },
            },
          },
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts Vue source files when source include expands defaults and Vue glob', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'tools/covered.vue':
          '<script setup lang="ts">const value = 1;</script>\n',
        'tools/tsconfig.json': JSON.stringify({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['covered.vue'],
        }),
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            checkers: {
              tsc: {
                exclude: ['**/tsconfig*.dts.json', '**/tsconfig*.build.json'],
                include: ['packages/pkg/tsconfig.json'],
              },
              'vue-tsc': {
                include: ['tools/tsconfig.json'],
              },
            },
            source: {
              include: ['...', '**/*.vue'],
            },
          },
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports checker-covered Svelte source files outside the default source boundary', async () => {
    const errorSpy = vi
      .spyOn(ProofLogger, 'error')
      .mockImplementation(() => {});
    const fixture = await createFixture(
      createPassingFiles({
        ...svelteCheckerPeerFiles,
        'tools/anchor.ts': 'export {};\n',
        'tools/covered.svelte': '<script>const value = 1;</script>\n',
        'tools/tsconfig.json': JSON.stringify({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['anchor.ts', 'covered.svelte'],
        }),
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            checkers: {
              tsc: {
                exclude: ['**/tsconfig*.dts.json', '**/tsconfig*.build.json'],
                include: ['packages/pkg/tsconfig.json'],
              },
              'svelte-check': {
                include: ['tools/tsconfig.json'],
              },
            },
          },
        }),
      ).resolves.toBe(false);
      const output = errorSpy.mock.calls.join('\n');

      expect(output).toContain(
        'Typecheck proof source boundary does not match tsconfig coverage',
      );
      expect(output).toContain('tools/covered.svelte');
    } finally {
      errorSpy.mockRestore();
      await fixture.cleanup();
    }
  });

  it('accepts Svelte source files when source include expands defaults and Svelte glob', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        ...svelteCheckerPeerFiles,
        'tools/anchor.ts': 'export {};\n',
        'tools/covered.svelte': '<script>const value = 1;</script>\n',
        'tools/tsconfig.json': JSON.stringify({
          compilerOptions: {
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['anchor.ts', 'covered.svelte'],
        }),
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            checkers: {
              tsc: {
                exclude: ['**/tsconfig*.dts.json', '**/tsconfig*.build.json'],
                include: ['packages/pkg/tsconfig.json'],
              },
              'svelte-check': {
                include: ['tools/tsconfig.json'],
              },
            },
            source: {
              include: ['...', '**/*.svelte'],
            },
          },
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not require coverage for excluded config json files', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'package.json': JSON.stringify({
          name: 'fixture',
        }),
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            source: {
              include: ['packages/pkg/src/**/*.ts', 'package.json'],
              exclude: ['package.json'],
            },
          },
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not require a shared typecheck root config', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'tsconfig.json': JSON.stringify({
          files: [],
          references: [],
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects project references in source typecheck leaf configs', async () => {
    const fixture = await createFixture({
      'packages/dep/src/index.ts': 'export const depValue = 1;\n',
      'packages/dep/tsconfig.json': JSON.stringify({
        compilerOptions: {
          lib: ['ES2023'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
      }),
      'packages/pkg/src/index.ts': 'export const value = 1;\n',
      'packages/pkg/test/index.ts': 'export const testValue = 1;\n',
      'packages/pkg/tsconfig.json': JSON.stringify({
        files: [],
        references: [
          {
            path: './tsconfig.lib.json',
          },
          {
            path: './tsconfig.test.json',
          },
        ],
      }),
      'packages/pkg/tsconfig.lib.json': JSON.stringify({
        compilerOptions: {
          lib: ['ES2023'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['src/**/*.ts'],
        references: [
          {
            path: '../dep/tsconfig.json',
          },
        ],
      }),
      'packages/pkg/tsconfig.test.json': JSON.stringify({
        compilerOptions: {
          lib: ['ES2023'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'ES2023',
          types: [],
        },
        include: ['test/**/*.ts'],
      }),
      'tsconfig.json': JSON.stringify({
        files: [],
        references: [
          {
            path: './packages/dep/tsconfig.json',
          },
          {
            path: './packages/pkg/tsconfig.json',
          },
        ],
      }),
    });

    try {
      await expect(runProofCheck(fixture.config)).rejects.toThrow(
        'Source typecheck config declares project references',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts solution-style default tsconfig references', async () => {
    const fixture = await createFixture(createPassingFiles());

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects default typecheck tsconfig files with empty references', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'root.ts': 'export const rootValue = 1;\n',
        'tsconfig.json': JSON.stringify({
          compilerOptions: {
            lib: ['ES2023'],
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            target: 'ES2023',
            types: [],
          },
          include: ['root.ts'],
          references: [],
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).rejects.toThrow(
        'Source typecheck config declares project references',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts semantic solutions with non-source-owning compiler options', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'tsconfig.json': JSON.stringify({
          compilerOptions: {
            strict: true,
          },
          files: [],
          references: [
            {
              path: './packages/pkg/tsconfig.json',
            },
          ],
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects implicitRefs on solution-style tsconfig aggregators', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'tsconfig.json': JSON.stringify({
          files: [],
          liminaOptions: {
            implicitRefs: [
              {
                path: './packages/pkg/tsconfig.json',
                reason: 'Aggregators do not own source files.',
              },
            ],
          },
          references: [
            {
              path: './packages/pkg/tsconfig.json',
            },
          ],
        }),
      }),
    );

    try {
      await expect(runProofCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('ignores inert shared graph root build configs', async () => {
    const fixture = await createFixture(
      createPassingFiles({
        'tsconfig.custom.build.json': JSON.stringify({
          files: [],
          references: [
            {
              path: './packages/pkg/tsconfig.lib.dts.json',
            },
          ],
        }),
        'tsconfig.build.json': JSON.stringify({
          files: [],
          references: [],
        }),
      }),
    );

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            checkers: {
              tsc: {
                include: ['packages/pkg/tsconfig.json'],
              },
            },
          },
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('accepts a direct graph-capable checker entry', async () => {
    const fixture = await createFixture(createPassingFiles());

    try {
      await expect(
        runProofCheck({
          ...fixture.config,
          config: {
            ...fixture.config.config,
            checkers: {
              tsc: {
                include: ['packages/pkg/tsconfig.json'],
              },
            },
          },
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });
});
