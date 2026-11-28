import type { ResolvedLiminaConfig } from '#config/runner';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'pathe';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  CoreSubscriptionViolationError,
  createAnalysisProviders,
  PackageArtifactProvider,
  planCapabilitySubscriptions,
  planRuleSubscriptions,
} from '../core';
import { ANALYSIS_SCHEMA } from '../core/analysis-cache/contracts';
import { NativeAnalysisCache } from '../core/analysis-cache/native-cache';
import { parseStoredAnalysisSnapshot } from '../core/analysis-cache/snapshot-schema';
import {
  ANALYSIS_STORAGE,
  encodeAnalysisBlocks,
  readAnalysisBlocks,
} from '../core/analysis-cache/snapshot-shards';
import { collectSourceConfigCoverage } from '../core/build-graph/source-config-coverage';
import { nativeConfigContextKey } from '../core/project-dependencies/provider';
import { getExplicitResolutionMode } from '../core/project-dependencies/resolution-mode';
import {
  collectProjectDependencies,
  collectRuntimeProjectDependencies,
  createProjectDependencyCaches,
} from '../core/project-dependencies/runner';
import { createWorkspaceSourceBoundary } from '../core/typescript-semantic';
import { extractFileDependencyFacts } from '../core/typescript-semantic/file-dependency-facts';
import { nativeContextInputs } from '../core/typescript-semantic/native-context-inputs';
import { NativeObservationAdapter } from '../core/typescript-semantic/native-observation-adapter';
import { parseTypeScriptProjectConfig } from '../core/typescript-semantic/project-references';
import { createLiminaArtifactNamespace } from '../domain/artifacts/namespace';
import { requiresPipelineSemanticFacts } from '../pipeline/steps';
import { LiminaPreflightManager } from '../preflight';
import { AnalysisCacheBlocks } from '../preflight/analysis-cache-blocks';
import { withTemporaryVirtualEntries } from '../source-check/knip/temporary';
import { withFixtureGovernanceRoot } from './helpers/governance-root';
import { createFixturePathResolver } from './helpers/path';
import { linkSemanticWorkspacePackages } from './helpers/semantic-repair';

function createWorkspaceFixture(
  files: Record<string, string>,
  overrides: Partial<ResolvedLiminaConfig> = {},
) {
  const rawRoot = mkdtempSync(path.join(tmpdir(), 'limina-060-facts-'));
  const rootDirectory = realpathSync.native(rawRoot);
  const resolvePath = createFixturePathResolver(rootDirectory);
  const defaults: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fixture-root', private: true }),
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    ...files,
  };
  for (const [relativePath, content] of Object.entries(defaults)) {
    const absolutePath = path.join(rootDirectory, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content);
  }
  const config = withFixtureGovernanceRoot({
    configPath: resolvePath('limina.config.mts'),
    rootDir: resolvePath(),
    scope: {
      checkers: {
        tsc: {
          include: ['tsconfig.json', '**/tsconfig.json'],
        },
      },
    },
    ...overrides,
  });
  return {
    config,
    path: resolvePath,
    rootDir: rootDirectory,
    cleanup() {
      rmSync(rootDirectory, { force: true, recursive: true });
    },
  };
}

function createTsconfig(include: readonly string[]): string {
  return JSON.stringify({
    compilerOptions: {
      module: 'ESNext',
      moduleResolution: 'bundler',
      noEmit: true,
      skipLibCheck: true,
      target: 'ES2022',
    },
    include,
  });
}

describe('0.6.0 Core fact production, subscriptions, and cache contracts', () => {
  it('plans built-in capability subscriptions in acyclic topological order and skips semantic cache for package/release pipelines', () => {
    const packagePlan = planCapabilitySubscriptions([
      'package:check',
      'release:check',
    ]);
    expect(packagePlan.requiresSemanticFacts).toBe(false);
    expect(packagePlan.products).toEqual(['workspace']);

    const fullPlan = planCapabilitySubscriptions([
      'graph:check',
      'source:check',
      'proof:check',
    ]);
    expect(fullPlan.requiresSemanticFacts).toBe(true);
    const stages = fullPlan.producers.map((producer) => producer.stage);
    expect(stages.indexOf('stage-a')).toBeLessThan(stages.indexOf('stage-b1'));
    expect(stages.indexOf('stage-b1')).toBeLessThan(stages.indexOf('stage-b2'));

    const fixture = createWorkspaceFixture(
      {
        'packages/a/package.json': JSON.stringify({ name: '@example/a' }),
        'packages/a/src/index.ts': 'export const a = 1;\n',
        'packages/a/tsconfig.json': createTsconfig(['src/**/*.ts']),
      },
      {
        pipelines: {
          pkg: ['package:check'],
          release: ['release:check'],
          graph: ['graph:check'],
        },
      },
    );
    try {
      expect(requiresPipelineSemanticFacts(fixture.config, 'pkg')).toBe(false);
      expect(requiresPipelineSemanticFacts(fixture.config, 'release')).toBe(
        false,
      );
      expect(requiresPipelineSemanticFacts(fixture.config, 'graph')).toBe(true);
      expect(requiresPipelineSemanticFacts(fixture.config, undefined)).toBe(
        true,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it('assigns distinct instance-scoped snapshotTokens to separate preflight managers on the same root', () => {
    const fixture = createWorkspaceFixture({
      'packages/a/package.json': JSON.stringify({ name: '@example/a' }),
      'packages/a/src/index.ts': 'export const a = 1;\n',
      'packages/a/tsconfig.json': createTsconfig(['src/**/*.ts']),
    });
    const first = new LiminaPreflightManager({ config: fixture.config });
    const second = new LiminaPreflightManager({ config: fixture.config });
    try {
      expect(first.run.snapshotToken).not.toBe(second.run.snapshotToken);
    } finally {
      first.dispose();
      second.dispose();
      fixture.cleanup();
    }
  });

  it('enumerates Proof expected source files without triggering generated graph preparation', async () => {
    const fixture = createWorkspaceFixture({
      'packages/a/package.json': JSON.stringify({ name: '@example/a' }),
      'packages/a/src/index.ts': 'export const a = 1;\n',
      'packages/a/tsconfig.json': createTsconfig(['src/**/*.ts']),
    });
    const preflight = new LiminaPreflightManager({
      config: fixture.config,
      generatedGraphProvider: async () => {
        throw new Error(
          'Generated graph must not be requested for physical source enumeration.',
        );
      },
    });
    try {
      const files = await preflight.ensureExpectedSourceFiles();
      expect([...files]).toContain(fixture.path('packages/a/src/index.ts'));
    } finally {
      preflight.dispose();
      fixture.cleanup();
    }
  });

  it('reuses locked Native facts for ordinary imports while retaining Runtime-only resolution for require.resolve', async () => {
    const fixture = createWorkspaceFixture({
      'packages/a/package.json': JSON.stringify({
        name: '@example/a',
        type: 'module',
        dependencies: { '@example/b': 'workspace:*' },
      }),
      'packages/a/src/index.ts': [
        "export { value } from '@example/b';",
        "export const resolved = require.resolve('@example/b');",
        '',
      ].join('\n'),
      'packages/a/tsconfig.json': createTsconfig(['src/**/*.ts']),
      'packages/b/package.json': JSON.stringify({
        name: '@example/b',
        type: 'module',
        exports: { '.': './src/index.ts' },
      }),
      'packages/b/src/index.ts': 'export const value = 42;\n',
      'packages/b/tsconfig.json': createTsconfig(['src/**/*.ts']),
    });
    try {
      await linkSemanticWorkspacePackages(fixture.rootDir, ['b']);
      const providers = createAnalysisProviders(fixture.config);
      try {
        const graph = await providers.buildGraph.getGraph();
        const unitA = graph.governedSources
          .values()
          .flatMap((units) => units.values())
          .find(
            (unit) =>
              unit.configPath === fixture.path('packages/a/tsconfig.json'),
          );
        expect(unitA).toBeDefined();

        const parsedProject = await providers.tsconfig.getProject(
          unitA!.configPath,
          unitA!.context,
        );
        const caches = providers.projectDependencies;
        const context = {
          compilerOptions: parsedProject.options,
          configPath: unitA!.configPath,
          extensions: [...unitA!.context.extensions],
          fileNames: [...unitA!.ownedFileNames],
          generation: providers.artifactNamespace.generation,
          packageRootByFileName: new Map(
            unitA!.ownedFileNames.map((file) => [
              file,
              fixture.path('packages/a'),
            ]),
          ),
          packageRootDir: fixture.path('packages/a'),
          references: [],
          resolverConfigPath: unitA!.configPath,
          semanticAuthority: parsedProject.semanticAuthority!,
          workspaceSourceBoundary: createWorkspaceSourceBoundary(
            unitA!.ownedFileNames,
          ),
        };

        const beforeReuses = caches.factCounters?.nativeResolutionReuses ?? 0;
        const firstRuntime = collectRuntimeProjectDependencies({
          caches,
          context,
          importAnalysis: providers.imports.context,
        });
        const secondRuntime = collectRuntimeProjectDependencies({
          caches,
          context,
          importAnalysis: providers.imports.context,
        });

        expect(firstRuntime.dependencies).toHaveLength(2);
        expect(secondRuntime.dependencies).toHaveLength(2);
        expect(
          (caches.factCounters?.nativeResolutionReuses ?? 0) - beforeReuses,
        ).toBeGreaterThanOrEqual(2);
        expect(caches.runtimeSourceResolvers?.size).toBe(1);
        expect(providers.facts.hasWorkspaceSourceBoundary()).toBe(true);

        const isolatedCaches = createProjectDependencyCaches();
        const cold = collectProjectDependencies({
          caches: isolatedCaches,
          context,
          importAnalysis: providers.imports.context,
        });
        expect(cold.dependencies.length).toBeGreaterThanOrEqual(1);
        expect(isolatedCaches.nativeContextsByConfig?.size).toBe(1);
      } finally {
        providers.dispose();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('cleans up all sibling temporary Knip entries when one concurrent owner fails', async () => {
    const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'limina-knip-gc-'));
    const validDirectory = path.join(temporaryRoot, 'pkg-valid');
    const blockedParent = path.join(temporaryRoot, 'pkg-blocked', '.tsbuild');
    const blockedDirectory = path.dirname(blockedParent);
    mkdirSync(validDirectory, { recursive: true });
    mkdirSync(blockedDirectory, { recursive: true });
    writeFileSync(blockedParent, 'not-a-directory');

    try {
      await expect(
        withTemporaryVirtualEntries(
          [
            {
              directory: validDirectory,
              entryFiles: [],
              ignoreFiles: [],
              projectFiles: [],
              virtualEntrySourceFiles: [
                path.join(validDirectory, 'src/index.ts'),
              ],
            },
            {
              directory: blockedDirectory,
              entryFiles: [],
              ignoreFiles: [],
              projectFiles: [],
              virtualEntrySourceFiles: [
                path.join(blockedDirectory, 'src/index.ts'),
              ],
            },
          ],
          async () => 'unexpected',
        ),
      ).rejects.toThrow();

      expect(existsSync(path.join(validDirectory, '.tsbuild'))).toBe(false);
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('reclaims expired unreachable cache blocks while preserving active and grace-window blocks', async () => {
    const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'limina-cache-gc-'));
    try {
      const namespace = createLiminaArtifactNamespace({
        generation: 0,
        rootDir: temporaryRoot,
      });
      const cacheDirectory = path.join(
        namespace.rootDir,
        'cache',
        'analysis-v2',
        'test',
      );
      const scopeDirectory = path.join(cacheDirectory, 'scopes', 'shared');
      mkdirSync(scopeDirectory, { recursive: true });

      const activeDigest = 'a'.repeat(64);
      const recentDigest = 'b'.repeat(64);
      const expiredDigest = 'c'.repeat(64);
      const activeFile = path.join(
        scopeDirectory,
        `${activeDigest}.liminainfo`,
      );
      const recentFile = path.join(
        scopeDirectory,
        `${recentDigest}.liminainfo`,
      );
      const expiredFile = path.join(
        scopeDirectory,
        `${expiredDigest}.liminainfo`,
      );

      writeFileSync(activeFile, 'active-payload');
      writeFileSync(recentFile, 'recent-unreachable');
      writeFileSync(expiredFile, 'expired-unreachable');

      const now = Date.now();
      const oldTime = new Date(now - 60 * 60 * 1000);
      utimesSync(activeFile, oldTime, oldTime);
      utimesSync(expiredFile, oldTime, oldTime);

      const blocks = new AnalysisCacheBlocks(namespace, cacheDirectory);
      const report = await blocks.sweepUnreachable(
        [
          {
            scope: null,
            kind: 'facts',
            digest: activeDigest,
            bytes: Buffer.byteLength('active-payload'),
          },
        ],
        { graceMs: 10 * 60 * 1000, now },
      );

      expect(report.reclaimedBlocks).toBe(1);
      expect(report.reclaimedBytes).toBe(
        Buffer.byteLength('expired-unreachable'),
      );
      expect(report.activeReferencedBytes).toBe(
        Buffer.byteLength('active-payload'),
      );
      expect(report.retainedBytes).toBe(
        Buffer.byteLength('active-payload') +
          Buffer.byteLength('recent-unreachable'),
      );
      expect(existsSync(activeFile)).toBe(true);
      expect(existsSync(recentFile)).toBe(true);
      expect(existsSync(expiredFile)).toBe(false);
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('deduplicates concurrent and sequential tarball packing in PackageArtifactProvider', async () => {
    const provider = new PackageArtifactProvider();
    let invocations = 0;
    const packFunction = async () => {
      invocations += 1;
      await Promise.resolve();
      return {
        tarball: Buffer.from('tarball-bytes'),
        tarballName: 'example-1.0.0.tgz',
      };
    };

    const [first, second] = await Promise.all([
      provider.getOrPackTarball('/tmp/pkg-a/dist', packFunction),
      provider.getOrPackTarball('/tmp/pkg-a/dist', packFunction),
    ]);
    const third = await provider.getOrPackTarball(
      '/tmp/pkg-a/dist',
      packFunction,
    );

    expect(invocations).toBe(1);
    expect(first.digest).toBe(second.digest);
    expect(second.digest).toBe(third.digest);
    expect(provider.getStats()).toEqual({ packCount: 1, reuseCount: 2 });
    provider.dispose();
  });

  it('enforces subscription boundaries and deduplicates runtime dependency collections by WorkIdentity', async () => {
    const fixture = createWorkspaceFixture({
      'packages/a/package.json': JSON.stringify({ name: '@example/a' }),
      'packages/a/src/index.ts': 'export const a = 1;\n',
      'packages/a/tsconfig.json': createTsconfig(['src/**/*.ts']),
    });
    const providers = createAnalysisProviders(fixture.config);
    try {
      const ownership = await providers.buildGraph.getOwnershipProjection();
      expect(ownership.selections.length).toBeGreaterThanOrEqual(1);
      expect(providers.facts.hasWorkspaceSourceBoundary()).toBe(true);

      const packageView = providers.facts.createSubscribedView(
        planCapabilitySubscriptions(['package:check']),
      );
      expect(() => packageView.getWorkspaceSourceBoundary()).toThrow(
        CoreSubscriptionViolationError,
      );

      const graphView = providers.facts.createSubscribedView(
        planCapabilitySubscriptions(['graph:check']),
      );
      const sourceView = providers.facts.createSubscribedView(
        planCapabilitySubscriptions(['source:check']),
      );
      const graph = await providers.buildGraph.getGraph();
      const unitA = graph.governedSources
        .values()
        .flatMap((units) => units.values())
        .find(
          (unit) =>
            unit.configPath === fixture.path('packages/a/tsconfig.json'),
        );
      expect(unitA).toBeDefined();
      const parsedProject = await providers.tsconfig.getProject(
        unitA!.configPath,
        unitA!.context,
      );
      const request = {
        context: {
          compilerOptions: parsedProject.options,
          configPath: unitA!.configPath,
          extensions: [...unitA!.context.extensions],
          fileNames: [...unitA!.ownedFileNames],
          generation: providers.artifactNamespace.generation,
          packageRootByFileName: new Map(
            unitA!.ownedFileNames.map((file) => [
              file,
              fixture.path('packages/a'),
            ]),
          ),
          packageRootDir: fixture.path('packages/a'),
          references: [],
          resolverConfigPath: unitA!.configPath,
          semanticAuthority: parsedProject.semanticAuthority!,
          workspaceSourceBoundary: graphView.getWorkspaceSourceBoundary(),
        },
        importAnalysis: providers.imports.context,
      };

      const fromGraph = graphView.getRuntimeProjectDependencies(request);
      const fromSource = sourceView.getRuntimeProjectDependencies(request);
      expect(fromSource).toBe(fromGraph);
      expect(providers.facts.getFactCounters().runtimeCollectionReuses).toBe(1);
    } finally {
      providers.dispose();
      fixture.cleanup();
    }
  });

  it('selectively reads only subscribed scope blocks from sharded analysis snapshots', () => {
    const snapshot = {
      header: {
        version: 29,
        identity: 'test-identity',
        configVersion: 'test-config',
        revision: 'rev-1',
        baselineTime: 1,
      },
      configModules: [],
      inputs: {},
      files: {},
      queries: {},
      runtimeQueries: {},
      importers: {},
      projects: {},
      contexts: {},
      vueContexts: {},
      sourceConfigs: {
        '/repo/packages/a/tsconfig.json': {
          configPath: '/repo/packages/a/tsconfig.json',
          digest: 'a',
        },
        '/repo/packages/b/tsconfig.json': {
          configPath: '/repo/packages/b/tsconfig.json',
          digest: 'b',
        },
      },
    } as never;

    const storedBlocks = new Map<string, Buffer>();
    const references = [];
    for (const block of encodeAnalysisBlocks(snapshot)) {
      storedBlocks.set(block.reference.digest, Buffer.from(block.text, 'utf8'));
      references.push(block.reference);
    }

    const readScopes: (string | null)[] = [];
    const restored = readAnalysisBlocks(
      {
        header: (snapshot as { header: unknown }).header,
        configModules: [],
        storage: {
          version: ANALYSIS_STORAGE,
          blocks: references,
        },
      },
      (reference) => {
        readScopes.push(reference.scope);
        return storedBlocks.get(reference.digest)!;
      },
      {
        filter: {
          scopes: new Set(['/repo/packages/a/tsconfig.json']),
        },
      },
    ) as { sourceConfigs: Record<string, unknown> };

    expect(Object.keys(restored.sourceConfigs)).toEqual([
      '/repo/packages/a/tsconfig.json',
    ]);
    expect(readScopes).not.toContain('/repo/packages/b/tsconfig.json');
    expect(readScopes).toContain('/repo/packages/a/tsconfig.json');
  });

  it('plans rule-level subscriptions and distinguishes Stage A/B1-only rules from Stage B2 rules', () => {
    const proofFilesPlan = planRuleSubscriptions([
      'proof:expected-source-files',
    ]);
    expect(proofFilesPlan.requiresSemanticFacts).toBe(false);
    expect(proofFilesPlan.requiresStageB2).toBe(false);
    expect(proofFilesPlan.products).toEqual(['workspace']);

    const sourceImportPlan = planRuleSubscriptions(['source:import-authority']);
    expect(sourceImportPlan.requiresSemanticFacts).toBe(true);
    expect(sourceImportPlan.requiresStageB2).toBe(false);
    expect(sourceImportPlan.products).toContain('runtime-only');
    expect(sourceImportPlan.products).not.toContain('graph');

    const graphReferencePlan = planRuleSubscriptions([
      'graph:reference-completeness',
    ]);
    expect(graphReferencePlan.requiresSemanticFacts).toBe(true);
    expect(graphReferencePlan.requiresStageB2).toBe(true);
    expect(graphReferencePlan.products).toContain('graph');
  });

  it('completes Stage B1 ownership projection via CoreOwnershipProvider without triggering Stage B2 graph preparation', async () => {
    const fixture = createWorkspaceFixture({
      'packages/a/package.json': JSON.stringify({ name: '@example/a' }),
      'packages/a/src/index.ts': 'export const a = 1;\n',
      'packages/a/tsconfig.json': createTsconfig(['src/**/*.ts']),
    });
    const preflight = new LiminaPreflightManager({
      config: fixture.config,
      generatedGraphProvider: async () => {
        throw new Error(
          'Stage B2 generated graph must not be requested for Stage B1 ownership projection.',
        );
      },
    });
    try {
      const ownership = await preflight.ensureOwnershipProjection();
      expect(ownership.selections.length).toBeGreaterThanOrEqual(1);
      expect(preflight.providers.facts.hasWorkspaceSourceBoundary()).toBe(true);
    } finally {
      preflight.dispose();
      fixture.cleanup();
    }
  });

  it('extracts strictly context-neutral FileDependencyFacts when reusing Bounded Program SourceFiles', () => {
    const cases: Record<string, string> = {
      '/virtual/plain.ts': 'const value = 1;\n',
      '/virtual/plain.mts': 'const value = 1;\n',
      '/virtual/plain.cts': 'const value = 1;\n',
      '/virtual/ambient.d.ts': [
        'declare module "ambient" {',
        '  import "./relative-inside-ambient";',
        '}',
        'export declare class Derived extends require("pkg").Base {}',
        '',
      ].join('\n'),
      '/virtual/ambient-script.d.ts':
        'declare module "ambient" { import "./relative"; }\n',
      '/virtual/jsx.tsx':
        '/** @jsxRuntime automatic */\nexport const el = <div />;\n',
      '/virtual/invalid-mode.ts':
        'import type { A } from "pkg" with { "resolution-mode": "invalid" };\n',
      '/virtual/valid-mode.ts':
        'import type { A } from "pkg" with { "resolution-mode": "require" };\n',
      '/virtual/cjs.js': 'const a = require("./a");\nmodule.exports = a;\n',
      '/virtual/data.json': '{"a": 1}\n',
    };
    const optionMatrices: ts.CompilerOptions[] = [
      { moduleDetection: ts.ModuleDetectionKind.Legacy, allowJs: true },
      { moduleDetection: ts.ModuleDetectionKind.Auto, allowJs: true },
      { moduleDetection: ts.ModuleDetectionKind.Force, allowJs: true },
      {
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        allowJs: true,
        resolveJsonModule: true,
        jsx: ts.JsxEmit.ReactJSX,
      },
    ];
    for (const options of optionMatrices) {
      const host = ts.createCompilerHost(options, true);
      host.fileExists = (fileName) => Object.hasOwn(cases, fileName);
      host.readFile = (fileName) => cases[fileName];
      host.getSourceFile = (fileName, languageVersion) =>
        Object.hasOwn(cases, fileName)
          ? ts.createSourceFile(
              fileName,
              cases[fileName]!,
              languageVersion,
              true,
            )
          : undefined;
      const program = ts.createProgram(Object.keys(cases), options, host);
      for (const [fileName, text] of Object.entries(cases)) {
        const programFile = program.getSourceFile(fileName);
        expect(programFile).toBeDefined();
        const neutral = extractFileDependencyFacts(fileName, text, 'v1');
        const reused = extractFileDependencyFacts(
          fileName,
          text,
          'v1',
          programFile,
        );
        expect(reused).toEqual(neutral);
      }
    }
  });

  it('resolves require, require.resolve, and createRequire aliases under CommonJS in NodeNext .mts modules (0.6.0)', async () => {
    const fixture = createWorkspaceFixture({
      'packages/a/package.json': JSON.stringify({
        name: '@example/a',
        type: 'module',
        dependencies: { '@example/b': 'workspace:*' },
      }),
      'packages/a/src/index.mts': [
        "import { createRequire } from 'node:module';",
        "import { esmValue } from '@example/b';",
        'const req = createRequire(import.meta.url);',
        "const freeReq = require('@example/b');",
        "const freeResolve = require.resolve('@example/b');",
        "const aliasReq = req('@example/b');",
        "const aliasResolve = req.resolve('@example/b');",
        'export const all = [esmValue, freeReq, freeResolve, aliasReq, aliasResolve];',
        '',
      ].join('\n'),
      'packages/a/tsconfig.json': JSON.stringify({
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          skipLibCheck: true,
          target: 'ES2022',
        },
        include: ['src/**/*.mts'],
      }),
      'packages/b/package.json': JSON.stringify({
        name: '@example/b',
        type: 'module',
        exports: {
          '.': {
            import: './dist/esm.d.mts',
            require: './src/cjs.cts',
          },
        },
      }),
      'packages/b/dist/esm.d.mts': 'export declare const esmValue: number;\n',
      'packages/b/src/cjs.cts': 'export const cjsValue = 1;\n',
      'packages/b/tsconfig.json': JSON.stringify({
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          skipLibCheck: true,
          target: 'ES2022',
        },
        include: ['src/**/*.cts'],
      }),
    });
    try {
      await linkSemanticWorkspacePackages(fixture.rootDir, ['b']);
      const providers = createAnalysisProviders(
        fixture.config,
        undefined,
        undefined,
        { subscriptionPlan: planCapabilitySubscriptions(['source:check']) },
      );
      try {
        const graph = await providers.buildGraph.getGraph();
        const unitA = graph.governedSources
          .values()
          .flatMap((units) => units.values())
          .find(
            (unit) =>
              unit.configPath === fixture.path('packages/a/tsconfig.json'),
          );
        expect(unitA).toBeDefined();
        const parsed = await providers.tsconfig.getProject(
          unitA!.configPath,
          unitA!.context,
        );
        const view = providers.facts.createSubscribedView(
          planCapabilitySubscriptions(['source:check']),
        );
        const runtime = view.getRuntimeProjectDependencies({
          context: {
            compilerOptions: parsed.options,
            configPath: unitA!.configPath,
            extensions: [...unitA!.context.extensions],
            fileNames: [...unitA!.ownedFileNames],
            generation: providers.artifactNamespace.generation,
            packageRootByFileName: new Map(
              unitA!.ownedFileNames.map((file) => [
                file,
                fixture.path('packages/a'),
              ]),
            ),
            packageRootDir: fixture.path('packages/a'),
            references: [],
            resolverConfigPath: unitA!.configPath,
            semanticAuthority: parsed.semanticAuthority!,
            workspaceSourceBoundary: view.getWorkspaceSourceBoundary(),
          },
          importAnalysis: providers.imports.context,
        });
        const bDependencies = runtime.dependencies.filter(
          (dependency) => dependency.importRecord.specifier === '@example/b',
        );
        expect(
          bDependencies.map((dependency) => ({
            kind: dependency.importRecord.kind,
            mode: dependency.resolutionMode,
            target: dependency.resolvedFilePath,
          })),
        ).toEqual([
          {
            kind: 'static',
            mode: 'import',
            target: fixture.path('packages/b/dist/esm.d.mts'),
          },
          {
            kind: 'commonjs',
            mode: 'require',
            target: fixture.path('packages/b/src/cjs.cts'),
          },
          {
            kind: 'require-resolve',
            mode: 'require',
            target: fixture.path('packages/b/src/cjs.cts'),
          },
          {
            kind: 'commonjs',
            mode: 'require',
            target: fixture.path('packages/b/src/cjs.cts'),
          },
          {
            kind: 'require-resolve',
            mode: 'require',
            target: fixture.path('packages/b/src/cjs.cts'),
          },
        ]);
      } finally {
        providers.dispose();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('reuses locked Native facts for import type and noResolve targets, preserves .ts JSDoc and JS shadowed require, and enforces subscription gates', async () => {
    const fixture = createWorkspaceFixture({
      'packages/a/package.json': JSON.stringify({
        name: '@example/a',
        type: 'module',
        dependencies: { '@example/b': 'workspace:*' },
      }),
      'packages/a/src/index.ts': [
        "import type { Value } from '@example/b';",
        '/** @type {import("@example/b").Value} */',
        'export const hinted: Value = 1;',
        '',
      ].join('\n'),
      'packages/a/src/shadow.js': [
        'export function run(require) {',
        "  return require('@example/b');",
        '}',
        '',
      ].join('\n'),
      'packages/a/tsconfig.json': JSON.stringify({
        compilerOptions: {
          allowJs: true,
          module: 'ESNext',
          moduleResolution: 'bundler',
          noEmit: true,
          noResolve: true,
          skipLibCheck: true,
          target: 'ES2022',
        },
        include: ['src/**/*.ts', 'src/**/*.js'],
      }),
      'packages/b/package.json': JSON.stringify({
        name: '@example/b',
        type: 'module',
        exports: { '.': './src/index.ts' },
      }),
      'packages/b/src/index.ts': 'export type Value = number;\n',
      'packages/b/tsconfig.json': createTsconfig(['src/**/*.ts']),
    });
    try {
      await linkSemanticWorkspacePackages(fixture.rootDir, ['b']);

      // Verify subscription gate rejects runtime-only production when plan omits runtime-only.
      const gatedProviders = createAnalysisProviders(
        fixture.config,
        undefined,
        undefined,
        { subscriptionPlan: planCapabilitySubscriptions(['proof:check']) },
      );
      try {
        expect(() =>
          gatedProviders.facts.getRuntimeProjectDependencies({
            context: {
              compilerOptions: {},
              configPath: fixture.path('packages/a/tsconfig.json'),
              extensions: ['.ts'],
              fileNames: [fixture.path('packages/a/src/index.ts')],
              generation: 0,
              packageRootByFileName: new Map(),
              packageRootDir: fixture.path('packages/a'),
              references: [],
              resolverConfigPath: fixture.path('packages/a/tsconfig.json'),
              semanticAuthority: {
                family: 'typescript',
                kind: 'locked',
                source: 'baseline',
              },
              workspaceSourceBoundary: createWorkspaceSourceBoundary([]),
            },
            importAnalysis: gatedProviders.imports.context,
          }),
        ).toThrow(CoreSubscriptionViolationError);
      } finally {
        gatedProviders.dispose();
      }

      // Verify paths declaration order sensitivity in nativeConfigContextKey.
      const baseContext = {
        configPath: fixture.path('packages/a/tsconfig.json'),
        extensions: ['.ts'],
        fileNames: [fixture.path('packages/a/src/index.ts')],
        generation: 0,
        packageRootByFileName: new Map<string, string>(),
        packageRootDir: fixture.path('packages/a'),
        references: [],
        resolverConfigPath: fixture.path('packages/a/tsconfig.json'),
        semanticAuthority: {
          family: 'typescript' as const,
          kind: 'locked' as const,
          source: 'baseline' as const,
        },
        workspaceSourceBoundary: createWorkspaceSourceBoundary([]),
      };
      const keyFirst = nativeConfigContextKey({
        ...baseContext,
        compilerOptions: { paths: { '@/*': ['./a/*'], '@a/*': ['./b/*'] } },
      });
      const keySwapped = nativeConfigContextKey({
        ...baseContext,
        compilerOptions: { paths: { '@a/*': ['./b/*'], '@/*': ['./a/*'] } },
      });
      expect(keyFirst).not.toBe(keySwapped);

      const providers = createAnalysisProviders(
        fixture.config,
        undefined,
        undefined,
        { subscriptionPlan: planCapabilitySubscriptions(['source:check']) },
      );
      try {
        const graph = await providers.buildGraph.getGraph();
        const unitA = graph.governedSources
          .values()
          .flatMap((units) => units.values())
          .find(
            (unit) =>
              unit.configPath === fixture.path('packages/a/tsconfig.json'),
          );
        expect(unitA).toBeDefined();
        const parsed = await providers.tsconfig.getProject(
          unitA!.configPath,
          unitA!.context,
        );
        const context = {
          compilerOptions: parsed.options,
          configPath: unitA!.configPath,
          extensions: [...unitA!.context.extensions],
          fileNames: [...unitA!.ownedFileNames],
          generation: providers.artifactNamespace.generation,
          packageRootByFileName: new Map(
            unitA!.ownedFileNames.map((file) => [
              file,
              fixture.path('packages/a'),
            ]),
          ),
          packageRootDir: fixture.path('packages/a'),
          references: [],
          resolverConfigPath: unitA!.configPath,
          semanticAuthority: parsed.semanticAuthority!,
          workspaceSourceBoundary: providers.facts.getWorkspaceSourceBoundary(),
        };
        const sourceView = providers.facts.createSubscribedView(
          planCapabilitySubscriptions(['source:check']),
        );
        const graphView = providers.facts.createSubscribedView(
          planCapabilitySubscriptions(['graph:check']),
        );
        const runtimeFromGraph = graphView.getRuntimeProjectDependencies({
          context,
          importAnalysis: providers.imports.context,
          managedOutputLookup: { resolve: () => null },
        });
        const runtimeFromSource = sourceView.getRuntimeProjectDependencies({
          context,
          importAnalysis: providers.imports.context,
        });
        // Plain TypeScript runtime collection is shared across graph:check and source:check
        // even when graph:check supplies managedOutputLookup and source:check omits it.
        expect(runtimeFromSource).toBe(runtimeFromGraph);
        expect(providers.facts.getFactCounters().nativeResolutionReuses).toBe(
          1,
        );
        // Only the .ts JSDoc import (absent from Native) uses Runtime-only resolution;
        // import type (even under noResolve: true) reuses locked Native target, and
        // shadowed JS require is excluded from lexical runtime governance.
        expect(providers.facts.getFactCounters().runtimeOnlyResolutions).toBe(
          1,
        );
        expect(
          runtimeFromSource.dependencies.map((dependency) => ({
            file: path.basename(dependency.importRecord.filePath),
            kind: dependency.importRecord.kind,
            target: dependency.resolvedFilePath,
          })),
        ).toEqual([
          {
            file: 'index.ts',
            kind: 'import-type',
            target: fixture.path('packages/b/src/index.ts'),
          },
          {
            file: 'index.ts',
            kind: 'jsdoc-import',
            target: fixture.path('packages/b/src/index.ts'),
          },
        ]);
      } finally {
        providers.dispose();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('persists isolated runtimeQueries across commands, hits warm .d.cts targets, isolates invalidation from Native, and observes new .vue fallbacks', async () => {
    const fixture = createWorkspaceFixture({
      'packages/a/package.json': JSON.stringify({
        name: '@example/a',
        type: 'module',
        dependencies: { '@example/b': 'workspace:*' },
      }),
      'packages/a/src/index.ts': [
        "import { esm } from './local';",
        "const cjs = require('@example/b');",
        "const maybeVue = require('./Widget');",
        'export const result = [esm, cjs, maybeVue];',
        '',
      ].join('\n'),
      'packages/a/src/local.ts': 'export const esm = 1;\n',
      'packages/a/tsconfig.json': JSON.stringify({
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          skipLibCheck: true,
          target: 'ES2022',
        },
        include: ['src/**/*.ts'],
      }),
      'packages/b/package.json': JSON.stringify({
        name: '@example/b',
        type: 'module',
        exports: {
          '.': {
            require: './dist/cjs.d.cts',
            import: './dist/esm.d.mts',
          },
        },
      }),
      'packages/b/dist/cjs.d.cts': 'export declare const cjs: number;\n',
      'packages/b/dist/esm.d.mts': 'export declare const esm: number;\n',
    });
    try {
      await linkSemanticWorkspacePackages(fixture.rootDir, ['b']);
      const identity = 'runtime-cache-phase4-test';
      const configVersion = 'cfg-v1';

      // Run 1: graph:prepare (no runtime-only subscription) persists Native contexts + FileDependencyFacts.
      const cache1 = new NativeAnalysisCache(
        identity,
        undefined,
        configVersion,
      );
      const providers1 = createAnalysisProviders(
        fixture.config,
        undefined,
        undefined,
        {
          analysisCache: cache1,
          subscriptionPlan: planCapabilitySubscriptions(['graph:prepare']),
        },
      );
      try {
        await providers1.buildGraph.getGraph();
      } finally {
        providers1.dispose();
      }
      const rawSnapshot1 = cache1.snapshot();
      rawSnapshot1.header.baselineTime = Date.now() + 10_000;
      const snapshot1 = parseStoredAnalysisSnapshot(
        rawSnapshot1,
        identity,
        configVersion,
      );
      expect(snapshot1).toBeDefined();
      expect(snapshot1!.header.schema).toBe(ANALYSIS_SCHEMA);
      expect(Object.keys(snapshot1!.runtimeQueries)).toHaveLength(0);

      // Run 2: Stage B1 ownership + source:check restores Native + FileDependencyFacts with
      // 0 Bounded Programs and 0 syntax parses, and supplements runtimeQueries (including a .d.cts target).
      const cache2 = new NativeAnalysisCache(
        identity,
        snapshot1,
        configVersion,
      );
      const providers2 = createAnalysisProviders(
        fixture.config,
        undefined,
        undefined,
        {
          analysisCache: cache2,
          subscriptionPlan: planCapabilitySubscriptions(['source:check']),
        },
      );
      try {
        await providers2.ownership.getOwnershipProjection();
        const configPath = fixture.path('packages/a/tsconfig.json');
        const parsed = await providers2.tsconfig.getProject(configPath, {
          checkerPresets: ['tsc'],
          extensions: ['.ts', '.vue'],
        });
        const view = providers2.facts.createSubscribedView(
          planCapabilitySubscriptions(['source:check']),
        );
        const runtime2 = view.getRuntimeProjectDependencies({
          context: {
            compilerOptions: parsed.options,
            configPath,
            extensions: ['.ts', '.vue'],
            fileNames: [...parsed.fileNames],
            generation: providers2.artifactNamespace.generation,
            packageRootByFileName: new Map(
              parsed.fileNames.map((file) => [
                file,
                fixture.path('packages/a'),
              ]),
            ),
            packageRootDir: fixture.path('packages/a'),
            references: [],
            resolverConfigPath: configPath,
            semanticAuthority: {
              family: 'typescript',
              kind: 'locked',
              source: 'baseline',
            },
            workspaceSourceBoundary: view.getWorkspaceSourceBoundary(),
          },
          importAnalysis: providers2.imports.context,
        });
        expect(cache2.metrics.semanticPrograms ?? 0).toBe(0);
        expect(cache2.metrics.sourceSyntaxParses ?? 0).toBe(0);
        expect(cache2.metrics.runtimeResolverCalls).toBe(2);
        expect(
          runtime2.dependencies.find(
            (dependency) => dependency.importRecord.specifier === '@example/b',
          )?.resolvedFilePath,
        ).toBe(fixture.path('packages/b/dist/cjs.d.cts'));
      } finally {
        providers2.dispose();
      }
      const rawSnapshot2 = cache2.snapshot();
      rawSnapshot2.header.baselineTime = Date.now() + 10_000;
      const snapshot2 = parseStoredAnalysisSnapshot(
        rawSnapshot2,
        identity,
        configVersion,
      );
      expect(snapshot2).toBeDefined();
      expect(Object.keys(snapshot2!.runtimeQueries)).toHaveLength(2);

      // Run 3: Warm source:check hits persisted runtimeQueries (including .d.cts!) with 0 runtime resolver calls.
      const cache3 = new NativeAnalysisCache(
        identity,
        snapshot2,
        configVersion,
      );
      const providers3 = createAnalysisProviders(
        fixture.config,
        undefined,
        undefined,
        {
          analysisCache: cache3,
          subscriptionPlan: planCapabilitySubscriptions(['source:check']),
        },
      );
      try {
        await providers3.ownership.getOwnershipProjection();
        const configPath = fixture.path('packages/a/tsconfig.json');
        const parsed = await providers3.tsconfig.getProject(configPath, {
          checkerPresets: ['tsc'],
          extensions: ['.ts', '.vue'],
        });
        const view = providers3.facts.createSubscribedView(
          planCapabilitySubscriptions(['source:check']),
        );
        view.getRuntimeProjectDependencies({
          context: {
            compilerOptions: parsed.options,
            configPath,
            extensions: ['.ts', '.vue'],
            fileNames: [...parsed.fileNames],
            generation: providers3.artifactNamespace.generation,
            packageRootByFileName: new Map(
              parsed.fileNames.map((file) => [
                file,
                fixture.path('packages/a'),
              ]),
            ),
            packageRootDir: fixture.path('packages/a'),
            references: [],
            resolverConfigPath: configPath,
            semanticAuthority: {
              family: 'typescript',
              kind: 'locked',
              source: 'baseline',
            },
            workspaceSourceBoundary: view.getWorkspaceSourceBoundary(),
          },
          importAnalysis: providers3.imports.context,
        });
        expect(cache3.metrics.semanticPrograms ?? 0).toBe(0);
        expect(cache3.metrics.sourceSyntaxParses ?? 0).toBe(0);
        expect(cache3.metrics.runtimeResolverCalls ?? 0).toBe(0);
        expect(cache3.metrics.runtimeQueryHits).toBe(2);
      } finally {
        providers3.dispose();
      }

      // Run 4: Adding ./Widget.vue (checker-only fallback) is immediately observed despite cached TS miss,
      // and modifying @example/b's runtime-only target invalidates runtimeResolutionDirty without tainting Native semanticDirty!
      writeFileSync(
        fixture.path('packages/a/src/Widget.vue'),
        '<script setup lang="ts">\nexport const w = 1;\n</script>\n',
      );
      writeFileSync(
        fixture.path('packages/b/package.json'),
        JSON.stringify({
          name: '@example/b',
          type: 'module',
          exports: {
            '.': {
              require: './dist/cjs-v2.d.cts',
              import: './dist/esm.d.mts',
            },
          },
        }),
      );
      writeFileSync(
        fixture.path('packages/b/dist/cjs-v2.d.cts'),
        'export declare const cjs: string;\n',
      );
      const cache4 = new NativeAnalysisCache(
        identity,
        snapshot2,
        configVersion,
      );
      expect(cache4.invalidation.runtimeResolutionDirty.size).toBeGreaterThan(
        0,
      );
      expect(cache4.invalidation.semanticDirty.size).toBe(0);
      const providers4 = createAnalysisProviders(
        fixture.config,
        undefined,
        undefined,
        {
          analysisCache: cache4,
          subscriptionPlan: planCapabilitySubscriptions(['source:check']),
        },
      );
      try {
        await providers4.ownership.getOwnershipProjection();
        const configPath = fixture.path('packages/a/tsconfig.json');
        const parsed = await providers4.tsconfig.getProject(configPath, {
          checkerPresets: ['tsc'],
          extensions: ['.ts', '.vue'],
        });
        const view = providers4.facts.createSubscribedView(
          planCapabilitySubscriptions(['source:check']),
        );
        const runtime4 = view.getRuntimeProjectDependencies({
          context: {
            compilerOptions: parsed.options,
            configPath,
            extensions: ['.ts', '.vue'],
            fileNames: [...parsed.fileNames],
            generation: providers4.artifactNamespace.generation,
            packageRootByFileName: new Map(
              parsed.fileNames.map((file) => [
                file,
                fixture.path('packages/a'),
              ]),
            ),
            packageRootDir: fixture.path('packages/a'),
            references: [],
            resolverConfigPath: configPath,
            semanticAuthority: {
              family: 'typescript',
              kind: 'locked',
              source: 'baseline',
            },
            workspaceSourceBoundary: view.getWorkspaceSourceBoundary(),
          },
          importAnalysis: providers4.imports.context,
        });
        // Native context was NOT invalidated or rebuilt!
        expect(cache4.metrics.semanticPrograms ?? 0).toBe(0);
        // Updated runtime-only target resolved to cjs-v2.d.cts!
        expect(
          runtime4.dependencies.find(
            (dependency) => dependency.importRecord.specifier === '@example/b',
          )?.resolvedFilePath,
        ).toBe(fixture.path('packages/b/dist/cjs-v2.d.cts'));
        // Newly added ./Widget.vue observed via checker-source fallback!
        expect(
          runtime4.observations.find(
            (obs) =>
              obs.kind === 'resource' &&
              obs.importRecord.specifier === './Widget',
          )?.evidence.runtime?.classification,
        ).toBe('checker-source');
      } finally {
        providers4.dispose();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('scopes setParentNodes to workspace sources and caches per-file explicit resolution modes', () => {
    const fixture = createWorkspaceFixture({
      'packages/a/package.json': JSON.stringify({
        name: '@example/a',
        type: 'module',
      }),
      'packages/a/src/index.ts': [
        "import type { A } from './a' with { 'resolution-mode': 'require' };",
        "import type { B } from './b' with { 'resolution-mode': 'import' };",
        "import { c } from './c';",
        "import type { Ext } from 'ext-pkg';",
        'export type Out = A & B & typeof c & Ext;',
        '',
      ].join('\n'),
      'packages/a/src/a.ts': 'export type A = 1;\n',
      'packages/a/src/b.ts': 'export type B = 2;\n',
      'packages/a/src/c.ts': 'export const c = 3;\n',
      'packages/a/node_modules/ext-pkg/package.json': JSON.stringify({
        name: 'ext-pkg',
        types: './index.d.ts',
      }),
      'packages/a/node_modules/ext-pkg/index.d.ts':
        'export interface Ext { value: string; }\n',
      'packages/a/tsconfig.json': JSON.stringify({
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          target: 'ES2022',
        },
        include: ['src/**/*.ts'],
      }),
    });
    try {
      const configPath = fixture.path('packages/a/tsconfig.json');
      const indexFile = fixture.path('packages/a/src/index.ts');
      const coverage = collectSourceConfigCoverage({
        universe: {
          id: 'activated-fixture',
          revision: '1',
          inputVersion: '1',
          selectionEvidenceId: 'explicit-fixture-selection',
          scopeFingerprint: 'fixture',
          sourceConfigIds: [configPath],
          discovery: 'closed',
        },
        parse: (targetConfigPath) =>
          parseTypeScriptProjectConfig({
            configPath: targetConfigPath,
            tsModule: ts,
          }),
      });
      const workspaceSourceBoundary = {
        ...createWorkspaceSourceBoundary([
          indexFile,
          fixture.path('packages/a/src/a.ts'),
          fixture.path('packages/a/src/b.ts'),
          fixture.path('packages/a/src/c.ts'),
        ]),
        sourceConfigCoverage: coverage,
      };
      const project = {
        admissionMode: 'coverage-bounded' as const,
        configPath,
        fileNames: [indexFile],
        options: {
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          noEmit: true,
          target: ts.ScriptTarget.ES2022,
        },
        sourceConfigPath: configPath,
        workspaceSourceBoundary,
      };
      const inputs = nativeContextInputs(project);

      const withoutParents = new NativeObservationAdapter({
        ...inputs,
        collectSyntaxParents: false,
      });
      const indexWithout = withoutParents.program.getSourceFile(indexFile)!;
      expect(indexWithout.endOfFileToken.parent).toBeUndefined();

      const withParents = new NativeObservationAdapter({
        ...inputs,
        collectSyntaxParents: true,
      });
      const indexWith = withParents.program.getSourceFile(indexFile)!;
      expect(indexWith.endOfFileToken.parent).toBe(indexWith);
      const defaultLibrary = withParents.program.getSourceFile(
        ts.getDefaultLibFilePath(project.options),
      );
      expect(defaultLibrary).toBeDefined();
      expect(defaultLibrary!.endOfFileToken.parent).toBeUndefined();
      const externalLibrary = withParents.program.getSourceFile(
        fixture.path('packages/a/node_modules/ext-pkg/index.d.ts'),
      );
      expect(externalLibrary).toBeDefined();
      expect(externalLibrary!.endOfFileToken.parent).toBeUndefined();

      const facts = extractFileDependencyFacts(
        indexFile,
        indexWith.text,
        'v1',
        indexWith,
      );
      let readCount = 0;
      const semanticContext = {
        getFileDependencyFacts: (file: string) => {
          readCount += 1;
          return file === indexFile ? structuredClone(facts) : undefined;
        },
      };
      const fakeRequest = {
        context: {
          compilerOptions: project.options,
          configPath,
          extensions: ['.ts'],
          fileNames: [indexFile],
          generation: 0,
          packageRootByFileName: new Map(),
          packageRootDir: fixture.path('packages/a'),
          references: [],
          resolverConfigPath: configPath,
          semanticAuthority: {
            family: 'typescript' as const,
            kind: 'locked' as const,
            source: 'baseline' as const,
          },
          workspaceSourceBoundary,
        },
        importAnalysis: {} as never,
        typeScriptSemanticContext: semanticContext as never,
      };
      const records = facts.requests.map((item) => item.occurrence);
      expect(records).toHaveLength(4);
      expect(
        getExplicitResolutionMode({
          importRecord: records[0]!,
          request: fakeRequest,
        }),
      ).toBe(ts.ModuleKind.CommonJS);
      expect(
        getExplicitResolutionMode({
          importRecord: records[1]!,
          request: fakeRequest,
        }),
      ).toBe(ts.ModuleKind.ESNext);
      expect(
        getExplicitResolutionMode({
          importRecord: records[2]!,
          request: fakeRequest,
        }),
      ).toBeUndefined();
      // Repeated lookups on the same file reuse the per-context explicit-mode index.
      expect(readCount).toBe(1);
    } finally {
      fixture.cleanup();
    }
  });
});
