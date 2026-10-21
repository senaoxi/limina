import { renameSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { EpochInputs } from '../core/analysis-cache/epoch-inputs';
import { NativeAnalysisCache } from '../core/analysis-cache/native-cache';
import { nativeEvidenceSchema } from '../core/analysis-cache/native-evidence-schema';
import { parseAnalysisSnapshot } from '../core/analysis-cache/snapshot-schema';
import { collectNativeSourceEvidence } from '../core/build-graph/native-source-collection';
import { analyzeProjectDependencies } from '../core/build-graph/prepare';
import { collectSourceConfigCoverage } from '../core/build-graph/source-config-coverage';
import { SourceConfigDiscovery } from '../core/build-graph/source-config-discovery';
import { projectNativeDeclarationClosure } from '../core/typescript-semantic/native-closure';
import { createNativeDependencyContext } from '../core/typescript-semantic/native-context-factory';
import { NativeDependencyContext } from '../core/typescript-semantic/native-dependency-context';
import { collectNativeEvidence } from '../core/typescript-semantic/native-evidence-collection';
import { qualifiedNativeDependencyTarget } from '../core/typescript-semantic/native-fact-qualification';
import { observeNativeFileIdentity } from '../core/typescript-semantic/native-file-identity';
import { NativeObservationAdapter } from '../core/typescript-semantic/native-observation-adapter';
import { createNativeObservationContext } from '../core/typescript-semantic/native-observation-context';
import { parseTypeScriptProjectConfig } from '../core/typescript-semantic/project-references';
import { createWorkspaceSourceBoundary } from '../core/typescript-semantic/workspace-source-boundary';
import {
  collectValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../core/workspace/validated-context';
import { nativeCollectionStatus } from '../domain/analysis/native-collection';
import { summarizeCompilationObligation } from '../domain/analysis/native-obligation';
import { projectNativeReferences } from '../domain/analysis/native-reference-projection';
import { createLiminaArtifactNamespace } from '../domain/artifacts/namespace';
import { withFixtureGovernanceRoot } from './helpers/governance-root';
import { createSemanticRepairFixture } from './helpers/semantic-repair';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const compilerOptions = {
  module: 'NodeNext',
  moduleResolution: 'NodeNext',
  target: 'ES2022',
  strict: true,
  ignoreDeprecations: '6.0',
};

async function setup(
  files: Record<string, string>,
  configs = ['tsconfig.json'],
  discovery: 'closed' | 'open' = 'closed',
) {
  const fixture = await createSemanticRepairFixture(files);
  cleanups.push(fixture.cleanup);
  const parsed = fixture.parse();
  const coverage = collectSourceConfigCoverage({
    universe: {
      id: 'activated-fixture',
      revision: '1',
      inputVersion: '1',
      selectionEvidenceId: 'explicit-fixture-selection',
      scopeFingerprint: 'fixture',
      sourceConfigIds: configs.map((config) => fixture.path(config)),
      discovery,
    },
    parse: (configPath) =>
      parseTypeScriptProjectConfig({ configPath, tsModule: ts }),
  });
  const project = {
    compilationObligationScope: 'generated-declaration-project-v1' as const,
    configPath: fixture.path('tsconfig.json'),
    fileNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
    workspaceSourceBoundary: createWorkspaceSourceBoundary(parsed.fileNames),
  };
  const context = createNativeObservationContext({
    project,
    coverage,
    epoch: '1',
    collectionId: 'pending-1',
    sourceVersion: '1',
    typescriptVersion: ts.version,
    typescriptImplementation: 'fixture-installed-typescript',
    toolchain: 'fixture-toolchain',
    authority: { phase: 'pending', baseline: 'typescript' },
  });
  return {
    fixture,
    project,
    coverage,
    adapter: new NativeObservationAdapter({ project, coverage, context }),
  };
}

function config(files: string[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ compilerOptions, files, ...extra });
}

describe('compiler-owned Native Program observations', () => {
  it('does not present an uncovered declaration frontier as a complete relation graph', async () => {
    const { adapter } = await setup({
      'tsconfig.json': config(['main.ts'], {
        compilerOptions: { ...compilerOptions, noLib: true, types: [] },
      }),
      'main.ts': 'import "./outside.js"; export {};',
      'outside.d.ts': 'import "./hidden.js"; export {};',
      'hidden.ts': 'export {};',
    });
    expect(
      adapter.snapshot.obligations.map(summarizeCompilationObligation),
    ).toEqual(['not-required']);
    expect(nativeCollectionStatus(adapter.snapshot)).toMatchObject({
      execution: 'completed',
      traversal: 'complete-within-boundary',
      compilationRelations: 'undetermined',
    });
    const projection = projectNativeReferences(adapter.snapshot);
    expect(projection.relationBoundaryIds.length).toBeGreaterThan(0);
    expect(projection.relations).toHaveLength(1);
    expect(adapter.snapshot.failures).toEqual([]);
  });
  it('preserves independent selected entries when solution discovery reaches a malformed config', async () => {
    const fixture = await createSemanticRepairFixture({
      'package.json': JSON.stringify({ name: 'native-fixture', private: true }),
      'limina.config.mjs': 'export default {};',
      'tsconfig.json': JSON.stringify({
        files: [],
        references: [
          { path: './tsconfig.good.json' },
          { path: './tsconfig.bad.json' },
        ],
      }),
      'tsconfig.good.json': config(['main.ts']),
      'tsconfig.bad.json': '{ "compilerOptions": ',
      'tsconfig.unselected.json': config(['main.ts']),
      'main.ts': 'import "./missing.js"; export {};',
    });
    cleanups.push(fixture.cleanup);
    const inputs = withFixtureGovernanceRoot({
      configPath: fixture.path('limina.config.mjs'),
      rootDir: fixture.root,
    });
    const workspace = await collectValidatedWorkspaceContext({
      config: inputs,
      rawPackages: [
        {
          directory: fixture.root,
          name: 'native-fixture',
          manifest: { name: 'native-fixture', private: true },
        },
      ],
    });
    const evidence = collectNativeSourceEvidence({
      config: inputs,
      entries: [fixture.path('tsconfig.json')],
      activatedRegions: new WorkspaceRegionPathIndex(workspace),
    });
    expect(evidence.coverageIndexes[0]!.universe.sourceConfigIds).toEqual([
      fixture.path('tsconfig.good.json'),
      fixture.path('tsconfig.bad.json'),
    ]);
    expect(evidence.requests).toContainEqual(
      expect.objectContaining({ specifier: './missing.js' }),
    );
    expect(evidence.failures).toContainEqual(
      expect.objectContaining({ kind: 'config-parse' }),
    );
    expect(nativeCollectionStatus(evidence)).toMatchObject({
      execution: 'partial',
      traversal: 'incomplete',
      compilationRelations: 'undetermined',
    });
    const analysis = await analyzeProjectDependencies(inputs, {
      artifactNamespace: createLiminaArtifactNamespace({
        generation: 0,
        rootDir: fixture.root,
      }),
      workspaceContext: workspace,
    });
    expect(
      analysis.nativeEvidence?.flatMap((item) => item.snapshot.requests),
    ).toContainEqual(expect.objectContaining({ specifier: './missing.js' }));
    expect(analysis.outcome).toMatchObject({
      execution: 'partial',
      traversal: 'incomplete',
      governance: { state: 'unavailable' },
      buildAdmission: { state: 'unavailable' },
    });
  });

  it('records raw leaf references before governance without granting the referenced config source ownership', async () => {
    const fixture = await createSemanticRepairFixture({
      'package.json': JSON.stringify({ name: 'native-fixture', private: true }),
      'limina.config.mjs': 'export default {};',
      'tsconfig.json': config(['main.ts'], {
        references: [{ path: './tsconfig.dep.json' }],
      }),
      'tsconfig.dep.json': config(['dep.ts'], {
        compilerOptions: {
          ...compilerOptions,
          composite: true,
          outDir: './dist',
        },
      }),
      'main.ts': 'import {value} from "./dep.js"; export {value};',
      'dep.ts': 'export const value=1;',
    });
    cleanups.push(fixture.cleanup);
    const inputs = withFixtureGovernanceRoot({
      configPath: fixture.path('limina.config.mjs'),
      rootDir: fixture.root,
    });
    const workspace = await collectValidatedWorkspaceContext({
      config: inputs,
      rawPackages: [
        {
          directory: fixture.root,
          name: 'native-fixture',
          manifest: { name: 'native-fixture', private: true },
        },
      ],
    });
    const evidence = collectNativeSourceEvidence({
      config: inputs,
      entries: [fixture.path('tsconfig.json')],
      activatedRegions: new WorkspaceRegionPathIndex(workspace),
    });
    expect(evidence.run).toBe('completed');
    expect(evidence.failures).toEqual([]);
    expect(evidence.coverageIndexes[0]!.universe.sourceConfigIds).toEqual([
      fixture.path('tsconfig.json'),
    ]);
    expect(evidence.relations).toContainEqual(
      expect.objectContaining({
        kind: 'explicit-reference',
        targetConfigId: fixture.path('tsconfig.dep.json'),
      }),
    );
  });

  it('retains JS compiler require and repeated imports without adopting TS runtime require', async () => {
    const { adapter, fixture } = await setup({
      'tsconfig.json': config(['main.ts', 'script.js'], {
        compilerOptions: { ...compilerOptions, allowJs: true },
      }),
      'main.ts':
        'import "./dep.js"; import "./dep.js"; require("./runtime.js");',
      'script.js': 'function f(require) { require("./shadow.js"); }',
      'dep.ts': 'import "./transitive.js"; export {};',
      'runtime.ts': 'export {};',
      'shadow.js': 'module.exports = 1;',
      'transitive.ts': 'export {};',
    });
    expect(adapter.modules.map((item) => item.literal.text)).toEqual([
      './dep.js',
      './dep.js',
      './shadow.js',
    ]);
    expect(new Set(adapter.modules.map((item) => item.requestId)).size).toBe(3);
    expect(
      adapter.program.getSourceFile(fixture.path('dep.ts')),
    ).toBeUndefined();
    expect(
      adapter.snapshot.resolutions.some(
        (resolution) =>
          resolution.target?.lexicalPath === fixture.path('dep.ts'),
      ),
    ).toBe(true);
    expect(
      adapter.snapshot.requests.some(
        (request) => request.specifier === './transitive.js',
      ),
    ).toBe(false);
    const context = new NativeDependencyContext(adapter.options);
    expect(
      context
        .getImportRecords(fixture.path('main.ts'))
        .map((record) => record.kind),
    ).toEqual(['static', 'static']);
    const records = context.getImportRecords(fixture.path('script.js'));
    expect(records.map((record) => record.kind)).toEqual(['commonjs']);
    expect(
      context.getDependencyFact(records[0]!).resolution.target
        ?.resolvedFileName,
    ).toBe(fixture.path('shadow.js'));
    expect(context.getImportRecords(fixture.path('dep.ts'))).toEqual([]);
  });

  it.each([
    { discovery: 'closed', owners: 0, expanded: false, state: 'uncovered' },
    { discovery: 'open', owners: 1, expanded: true, state: 'unavailable' },
    { discovery: 'closed', owners: 1, expanded: true, state: 'unique' },
    { discovery: 'open', owners: 2, expanded: true, state: 'ambiguous' },
  ] as const)(
    'enforces the physical declaration frontier: $state',
    async ({ discovery, owners, expanded, state }) => {
      const configs = [
        'tsconfig.json',
        ...['env-a.json', 'env-b.json'].slice(0, owners),
      ];
      const { adapter, fixture } = await setup(
        {
          'tsconfig.json': config(['main.ts']),
          'main.ts': 'import "./env.js"; export {};',
          'env.d.ts': 'import "./next.js"; export {};',
          'next.ts': 'export {};',
          'env-a.json': config(['env.d.ts']),
          'env-b.json': config(['env.d.ts']),
        },
        configs,
        discovery,
      );
      const attempt = adapter.frontier.attempts.find(
        (value) => value.file.lexicalPath === fixture.path('env.d.ts'),
      );
      expect(attempt?.coverage.state).toBe(state);
      expect(
        adapter.program.getSourceFile(fixture.path('env.d.ts')) !== undefined,
      ).toBe(expanded);
      expect(
        adapter.snapshot.requests.some(
          (request) => request.specifier === './next.js',
        ),
      ).toBe(expanded);
      // Full Program is an independent test Oracle, never a production fallback.
      const oracle = ts.createProgram(
        [fixture.path('main.ts')],
        adapter.program.getCompilerOptions(),
      );
      expect(oracle.getSourceFile(fixture.path('env.d.ts'))).toBeDefined();
    },
  );

  it('preserves actual reference config parsing without admitting reference implementation roots', async () => {
    const { adapter, fixture } = await setup(
      {
        'tsconfig.json': config(['main.ts'], {
          references: [{ path: './dep.json' }],
        }),
        'main.ts': 'import "./dep.js"; export {};',
        'dep.json': config(['dep.ts'], {
          compilerOptions: {
            ...compilerOptions,
            composite: true,
            outDir: './out',
          },
        }),
        'dep.ts': 'import "./nested.js"; export {};',
        'nested.ts': 'export {};',
      },
      ['tsconfig.json', 'dep.json'],
    );
    expect(adapter.configReads).toContain(fixture.path('dep.json'));
    expect(adapter.program.getProjectReferences()).toEqual(
      adapter.options.project.projectReferences,
    );
    expect(adapter.snapshot.relations).toContainEqual(
      expect.objectContaining({
        kind: 'explicit-reference',
        targetConfigId: fixture.path('dep.json'),
      }),
    );
    expect(
      adapter.program.getResolvedProjectReferences()?.[0]?.commandLine
        .fileNames,
    ).toContain(fixture.path('dep.ts'));
    expect(
      adapter.program.getSourceFile(fixture.path('dep.ts')),
    ).toBeUndefined();
    expect(
      adapter.snapshot.requests.some(
        (request) => request.specifier === './nested.js',
      ),
    ).toBe(false);
  });

  it('collects own ambient fast paths omitted by resolution callbacks', async () => {
    const { adapter } = await setup({
      'tsconfig.json': config(['ambient.d.ts']),
      'ambient.d.ts':
        'declare module "self" { import { A } from "self"; export interface A {} }',
    });
    expect(
      adapter.snapshot.requests.filter(
        (request) => request.specifier === 'self',
      ),
    ).toHaveLength(1);
    expect(
      adapter.snapshot.resolutions.some(
        (resolution) => resolution.state === 'ambient',
      ),
    ).toBe(true);
  });

  it('keeps configured types and real library requests without loading uncovered declarations', async () => {
    const { adapter, fixture } = await setup({
      'tsconfig.json': config(['main.ts'], {
        compilerOptions: {
          ...compilerOptions,
          types: ['./env'],
          lib: ['ES2022'],
        },
      }),
      'main.ts': 'export {};',
      'env.d.ts': 'import "./hidden.js"; export {};',
      'hidden.ts': 'export {};',
    });
    const type = adapter.snapshot.requests.find(
      (request) => request.specifier === './env',
    );
    expect(type?.entry).toEqual({
      kind: 'config',
      configId: fixture.path('tsconfig.json'),
      field: 'types[0]',
    });
    expect(
      adapter.snapshot.requests.some(
        (request) => request.channel === 'library',
      ),
    ).toBe(true);
    expect(adapter.program.getCompilerOptions().lib).toEqual([
      'lib.es2022.d.ts',
    ]);
    expect(adapter.program.getCompilerOptions().types).toEqual(['./env']);
    const typeObligation = adapter.snapshot.obligations.find((item) =>
      item.requestIds.includes(type!.id),
    )!;
    expect(summarizeCompilationObligation(typeObligation)).toBe('not-required');
    expect(
      adapter.program.getSourceFiles().map((file) => file.fileName),
    ).toEqual([fixture.path('main.ts')]);
    expect(
      adapter.snapshot.requests.some(
        (request) => request.specifier === './hidden.js',
      ),
    ).toBe(false);
  });

  it('retains implicit JSX and helper compiler requests with explicit synthetic provenance', async () => {
    const { adapter } = await setup({
      'tsconfig.json': config(['main.tsx'], {
        compilerOptions: {
          ...compilerOptions,
          jsx: 'react-jsx',
          importHelpers: true,
        },
      }),
      'main.tsx': 'export const element = <div />;',
    });
    const implicit = adapter.snapshot.requests.filter(
      (request) => request.channel === 'implicit',
    );
    expect(implicit.map((request) => request.specifier)).toEqual([
      'tslib',
      'react/jsx-runtime',
    ]);
    expect(implicit.every((request) => request.entry.kind === 'compiler')).toBe(
      true,
    );
  });

  it('keeps noResolve module observations while proving that no implementation was attempted', async () => {
    const { adapter, fixture } = await setup({
      'tsconfig.json': config(['main.ts'], {
        compilerOptions: { ...compilerOptions, noResolve: true },
      }),
      'main.ts': 'import "./dep.js"; export {};',
      'dep.ts': 'export const value = 1;',
    });
    const result = adapter.snapshot.resolutions.find(
      (resolution) => resolution.target?.lexicalPath === fixture.path('dep.ts'),
    );
    expect(result?.state).toBe('resolved');
    expect(result?.compilerLoad).toBe('not-observed');
    expect(
      adapter.frontier.attempts.some(
        (attempt) => attempt.file.lexicalPath === fixture.path('dep.ts'),
      ),
    ).toBe(false);
  });

  it('does not prove declaration uniqueness when another selected config fails parsing', async () => {
    const { adapter, fixture } = await setup(
      {
        'tsconfig.json': config(['main.ts']),
        'main.ts': 'import "./env.js"; export {};',
        'env.d.ts': 'import "./hidden.js"; export {};',
        'hidden.ts': 'export {};',
        'good.json': config(['env.d.ts']),
        'broken.json':
          '{"extends":"./missing-config.json","files":["other.ts"]}',
      },
      ['tsconfig.json', 'good.json', 'broken.json'],
    );
    const attempt = adapter.frontier.attempts.find(
      (entry) => entry.file.lexicalPath === fixture.path('env.d.ts'),
    );
    expect(attempt?.coverage.members).toHaveLength(1);
    expect(attempt?.coverage.state).toBe('unavailable');
    expect(
      adapter.program.getSourceFile(fixture.path('env.d.ts')),
    ).toBeDefined();
  });

  it('rejects stale context inputs instead of relabeling observations', async () => {
    const { adapter, project, coverage } = await setup({
      'tsconfig.json': config(['main.ts']),
      'main.ts': 'export {};',
    });
    expect(
      () =>
        new NativeObservationAdapter({
          context: adapter.options.context,
          coverage,
          project: {
            ...project,
            options: { ...project.options, noResolve: true },
          },
        }),
    ).toThrow('context input drift');
    expect(
      () =>
        new NativeObservationAdapter(adapter.options, {
          ...ts,
          version: '6.1.0',
        }),
    ).toThrow('unavailable for TypeScript 6.1.0');
  });

  it('revokes resolved-only target identity when replacement happens before evidence publication', async () => {
    const { adapter, fixture } = await setup({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { ...compilerOptions, noResolve: true },
        files: ['main.ts'],
      }),
      'main.ts': 'import "./foreign.js";',
      'foreign.ts': 'export {};',
      'replacement.ts': 'export {};',
    });
    expect(
      adapter.program.getSourceFile(fixture.path('foreign.ts')),
    ).toBeUndefined();
    const compiler = {
      ...ts,
      createProgram: ((...arguments_: Parameters<typeof ts.createProgram>) => {
        const program = ts.createProgram(...arguments_);
        renameSync(fixture.path('replacement.ts'), fixture.path('foreign.ts'));
        return program;
      }) as typeof ts.createProgram,
    };
    expect(
      () => new NativeObservationAdapter(adapter.options, compiler),
    ).toThrow('Native source identity drift');
  });

  it('keeps unreadable roots unavailable instead of publishing a complete empty graph', async () => {
    const { adapter } = await setup({
      'tsconfig.json': config(['absent.ts']),
    });
    expect(adapter.snapshot.run).toBe('unavailable');
    expect(adapter.snapshot.failures).toHaveLength(1);
    expect(adapter.program.getSourceFiles()).toHaveLength(0);
  });

  it('invalidates the coverage epoch for configuration, membership and physical identity changes', async () => {
    const { fixture } = await setup({
      'tsconfig.json': config(['main.ts']),
      'main.ts': 'export {};',
      'replacement.ts': 'export {};',
    });
    const observe = (basis: string, files = [fixture.path('main.ts')]) => {
      const discovery = new SourceConfigDiscovery(
        [fixture.path('tsconfig.json')],
        'same-cache-generation',
      );
      discovery.parsed(fixture.path('tsconfig.json'), files, {
        isSolution: false,
        basis,
      });
      discovery.close();
      return discovery.snapshot();
    };
    const initial = observe('config-1');
    expect(observe('config-1')).toEqual(initial);
    expect(observe('config-2').inputVersion).not.toBe(initial.inputVersion);
    expect(observe('config-1', []).inputVersion).not.toBe(initial.inputVersion);
    await rename(fixture.path('replacement.ts'), fixture.path('main.ts'));
    expect(observe('config-1').inputVersion).not.toBe(initial.inputVersion);
  });

  it('completes bounded traversal while retaining unresolved and unknown compilation relations', async () => {
    const { adapter } = await setup({
      'tsconfig.json': config(['main.ts']),
      'main.ts': 'import "./missing.js"; import "./dep.js";',
      'dep.ts': 'export {};',
    });
    const status = nativeCollectionStatus(adapter.snapshot);
    expect(status.execution).toBe('completed');
    expect(status.traversal).toBe('complete-within-boundary');
    expect(status.compilationRelations).toBe('undetermined');
    expect(adapter.snapshot.failures).toEqual([]);
    const projection = projectNativeReferences(adapter.snapshot);
    expect(projection.relations).toHaveLength(adapter.snapshot.requests.length);
    expect(projection.unresolvedObligationIds).toHaveLength(1);
    expect(projection.relations.map((relation) => relation.summary)).toContain(
      'not-required',
    );
    expect(
      adapter.snapshot.resolutions.map((resolution) => resolution.state),
    ).toContain('unresolved');
    expect(adapter.snapshot.completeness).toContainEqual(
      expect.objectContaining({
        state: 'proven-stop',
        stopReason: 'unresolved',
      }),
    );
  });

  it('restores a bounded context without a Program and invalidates a formerly missing target', async () => {
    const { project, coverage, fixture } = await setup({
      'tsconfig.json': config(['main.ts']),
      'main.ts': 'import "./late.js"; export {};',
    });
    const input = {
      ...project,
      admissionMode: 'coverage-bounded' as const,
      analysisBinding: { phase: 'locked' as const, checker: 'tsc' },
      workspaceSourceBoundary: createWorkspaceSourceBoundary(
        project.fileNames,
        undefined,
        coverage,
      ),
    };
    const first = new NativeAnalysisCache(
      'bounded-fixture',
      undefined,
      'config-1',
    );
    const cold = createNativeDependencyContext(input, first);
    const snapshot = parseAnalysisSnapshot(
      first.snapshot(),
      'bounded-fixture',
      'config-1',
    );
    expect(snapshot).toBeDefined();
    expect(snapshot!.header.schema).toBe(10);
    const warm = new NativeAnalysisCache(
      'bounded-fixture',
      snapshot,
      'config-1',
    );
    const restored = warm.restoreContext(input);
    expect(restored).toBeDefined();
    expect(restored!.nativeEvidence).toEqual(cold.nativeEvidence);
    expect(warm.metrics.semanticPrograms).toBe(0);
    expect(warm.metrics.restoredContexts).toBe(1);
    const foreignFacts = structuredClone(snapshot!);
    const importer = Object.values(foreignFacts.importers)[0]!;
    const factId = Object.keys(importer.facts)[0]!;
    importer.facts[factId] = {
      ...importer.facts[factId]!,
      nativeEvidence: {
        ...importer.facts[factId]!.nativeEvidence!,
        requestId: 'absent-request',
      },
    };
    expect(
      parseAnalysisSnapshot(foreignFacts, 'bounded-fixture', 'config-1'),
    ).toBeUndefined();
    const forgedRequirement = structuredClone(snapshot!);
    const forgedImporter = Object.values(forgedRequirement.importers)[0]!;
    forgedImporter.facts[factId]!.referenceRequirement = {
      kind: 'compiler-membership',
      targetFileName: fixture.path('late.ts'),
    };
    expect(
      parseAnalysisSnapshot(forgedRequirement, 'bounded-fixture', 'config-1'),
    ).toBeUndefined();
    const relabeled = structuredClone(snapshot!);
    const context = Object.values(relabeled.contexts)[0]!;
    context.project.analysisBinding = { phase: 'pending', checker: 'tsc' };
    expect(
      parseAnalysisSnapshot(relabeled, 'bounded-fixture', 'config-1'),
    ).toBeUndefined();
    expect(
      parseAnalysisSnapshot(
        {
          ...snapshot,
          header: { ...snapshot!.header, schema: 8 },
        },
        'bounded-fixture',
        'config-1',
      ),
    ).toBeUndefined();
    await writeFile(fixture.path('late.ts'), 'export {};');
    const changed = new NativeAnalysisCache(
      'bounded-fixture',
      snapshot,
      'config-1',
    );
    expect(changed.restoreContext(input)).toBeUndefined();
  });

  it('retains independent context evidence after an input transaction fails', async () => {
    const failed = await setup({
      'tsconfig.json': config(['main.ts']),
      'main.ts': 'import "./invalid-context.js";',
    });
    const healthy = await setup({
      'tsconfig.json': config(['main.ts']),
      'main.ts': 'import "./covered.js";',
      'covered.ts': 'export {};',
    });
    const evidence = collectNativeEvidence([
      {
        ...failed.adapter.options,
        project: {
          ...failed.project,
          options: { ...failed.project.options, noResolve: true },
        },
      },
      healthy.adapter.options,
    ]);
    expect(evidence.failures).toEqual([
      expect.objectContaining({
        kind: 'input-drift',
        affected: {
          kind: 'contexts',
          contextIds: [failed.adapter.options.context.id],
        },
      }),
    ]);
    expect(evidence.requests.map((request) => request.specifier)).toContain(
      './covered.js',
    );
    expect(evidence.requests.map((request) => request.specifier)).not.toContain(
      './invalid-context.js',
    );
    expect(nativeCollectionStatus(evidence)).toMatchObject({
      execution: 'partial',
      traversal: 'incomplete',
      compilationRelations: 'undetermined',
    });
    expect(projectNativeReferences(evidence).completeness).toBe('undetermined');
  });

  it('preserves shared declaration provenance through both incoming entries', async () => {
    const { adapter, fixture } = await setup({
      'tsconfig.json': config(['first.ts', 'second.ts', 'env.d.ts']),
      'first.ts': 'import "./env.js";',
      'second.ts': 'import "./env.js";',
      'env.d.ts': 'import "./end.js";',
      'end.ts': 'export {};',
    });
    const request = adapter.snapshot.requests.find(
      (entry) => entry.specifier === './end.js',
    )!;
    const link = adapter.snapshot.traversal.find(
      (entry) => entry.requestId === request.id,
    )!;
    expect(link.parentRequestIds).toHaveLength(2);
    expect(link.rootFileNames).toEqual([fixture.path('env.d.ts')]);
    expect(new Set(link.parentRequestIds)).toEqual(
      new Set(
        adapter.snapshot.requests
          .filter((entry) => entry.specifier === './env.js')
          .map((entry) => entry.id),
      ),
    );
  });

  it('keeps unknown path obligations and projects only the compiler bounded closure', async () => {
    const { adapter, project, fixture } = await setup({
      'tsconfig.json': config(['main.ts', 'env.d.ts']),
      'main.ts':
        '/// <reference path="./foreign.ts" />\nimport "./env.js"; import "./outside.js";',
      'env.d.ts': 'import "./inside.js";',
      'inside.ts': 'export {};',
      'outside.d.ts': 'import "./never.js";',
      'never.ts': 'export {};',
      'foreign.ts': 'export {};',
    });
    const context = new NativeDependencyContext(adapter.options);
    const projection = projectNativeDeclarationClosure(context, project);
    expect(projection.records.map((item) => item.specifier)).toContain(
      './inside.js',
    );
    expect(projection.records.map((item) => item.specifier)).not.toContain(
      './never.js',
    );
    expect(projection.incomplete).toEqual([]);
    const request = adapter.snapshot.requests.find(
      (item) => item.channel === 'path-directive',
    )!;
    const obligation = adapter.snapshot.obligations.find((item) =>
      item.requestIds.includes(request.id),
    )!;
    expect(summarizeCompilationObligation(obligation)).toBe('unknown');
    expect(
      adapter.program.getSourceFile(fixture.path('foreign.ts')),
    ).toBeUndefined();
    expect(nativeCollectionStatus(adapter.snapshot).execution).toBe(
      'completed',
    );
  });

  it('revokes epoch and restored identity qualification when an inode is replaced with equal bytes', async () => {
    const { fixture } = await setup({
      'tsconfig.json': config(['main.ts']),
      'main.ts': 'export {};',
      'replacement.ts': 'export {};',
    });
    const epoch = new EpochInputs();
    epoch.run(() =>
      observeNativeFileIdentity(fixture.path('main.ts'), 'epoch-1'),
    );
    const saved = epoch.snapshot()!;
    expect(await new EpochInputs().validate(saved)).toBe(true);
    await rename(fixture.path('replacement.ts'), fixture.path('main.ts'));
    await expect(epoch.assertStable()).rejects.toThrow();
    expect(await new EpochInputs().validate(saved)).toBe(false);
  });

  it('collects fresh locked compiler facts without upgrading cached pending objects', async () => {
    const { project, coverage, fixture } = await setup(
      {
        'tsconfig.json': config(['main.ts']),
        'main.ts': 'import "./dep.js";',
        'dep.json': config(['dep.ts']),
        'dep.ts': 'export {};',
      },
      ['tsconfig.json', 'dep.json'],
    );
    const input = {
      ...project,
      workspaceSourceBoundary: createWorkspaceSourceBoundary(
        project.fileNames,
        undefined,
        coverage,
      ),
    };
    const pending = createNativeDependencyContext({
      ...input,
      analysisBinding: { phase: 'pending', checker: 'tsc' },
    });
    const bytes = JSON.stringify(pending.nativeEvidence);
    const serialized = JSON.parse(bytes);
    const restored = nativeEvidenceSchema.parse(serialized);
    expect(restored).toEqual(pending.nativeEvidence);
    const locked = createNativeDependencyContext({
      ...input,
      analysisBinding: { phase: 'locked', checker: 'tsc' },
    });
    const pendingFact = pending.getDependencyFact(
      pending.getImportRecords(fixture.path('main.ts'))[0]!,
    );
    const lockedFact = locked.getDependencyFact(
      locked.getImportRecords(fixture.path('main.ts'))[0]!,
    );
    expect(
      qualifiedNativeDependencyTarget(pendingFact.nativeEvidence!),
    ).toBeNull();
    expect(qualifiedNativeDependencyTarget(lockedFact.nativeEvidence!)).toBe(
      fixture.path('dep.json'),
    );
    expect(locked.nativeEvidence!.contexts[0]!.id).not.toBe(
      restored.contexts[0]!.id,
    );
    expect(locked.nativeEvidence!.contexts[0]!.collectionId).not.toBe(
      restored.contexts[0]!.collectionId,
    );
    expect(restored.contexts[0]!.authority.phase).toBe('pending');
    expect(locked.nativeEvidence!.contexts[0]!.inputs.typescriptVersion).toBe(
      '6.0.3',
    );
    expect(
      nativeEvidenceSchema.safeParse({ ...serialized, version: 1 }).success,
    ).toBe(false);
    const unscoped = createNativeDependencyContext({
      ...input,
      compilationObligationScope: undefined,
      analysisBinding: { phase: 'locked', checker: 'tsc' },
    });
    const unscopedFact = unscoped.getDependencyFact(
      unscoped.getImportRecords(fixture.path('main.ts'))[0]!,
    );
    expect(unscopedFact.nativeEvidence!.coverage!.state).toBe('unique');
    expect(
      summarizeCompilationObligation(unscopedFact.nativeEvidence!.obligation!),
    ).toBe('unknown');
    expect(
      qualifiedNativeDependencyTarget(unscopedFact.nativeEvidence!),
    ).toBeNull();
  });

  it.each([
    {
      name: 'missing reference',
      noResolve: false,
      references: [],
      expected: 'required',
      diagnostic: 6307,
    },
    {
      name: 'wrong reference',
      noResolve: false,
      references: [{ path: './other.json' }],
      expected: 'required',
      diagnostic: 6307,
    },
    {
      name: 'missing output',
      noResolve: false,
      references: [{ path: './dep.json' }],
      expected: 'already-satisfied',
      diagnostic: 6305,
    },
    {
      name: 'noResolve owner hit',
      noResolve: true,
      references: [],
      expected: 'unknown',
      diagnostic: 2307,
    },
  ])(
    'separates obligation, reference structure and output: $name',
    async ({ noResolve, references, expected, diagnostic }) => {
      const { adapter, fixture, project } = await setup(
        {
          'tsconfig.json': config(['main.ts'], {
            compilerOptions: {
              ...compilerOptions,
              composite: true,
              outDir: './out/main',
              noResolve,
            },
            references,
          }),
          'main.ts':
            'import {value} from "./dep.js"; export const output=value;',
          'dep.json': config(['dep.ts'], {
            compilerOptions: {
              ...compilerOptions,
              composite: true,
              outDir: './out/dep',
            },
          }),
          'dep.ts': 'export const value=1;',
          'other.json': config(['other.ts'], {
            compilerOptions: {
              ...compilerOptions,
              composite: true,
              outDir: './out/other',
            },
          }),
          'other.ts': 'export const other=1;',
        },
        ['tsconfig.json', 'dep.json', 'other.json'],
      );
      const obligation = adapter.snapshot.obligations[0]!;
      expect(summarizeCompilationObligation(obligation)).toBe(expected);
      expect(obligation.targetConfigId).toBe(fixture.path('dep.json'));
      if (expected === 'already-satisfied') {
        expect(obligation.structure.state).toBe('satisfied');
        expect(obligation.artifact.state).toBe('missing');
      }
      const oracle = ts.createProgram({
        rootNames: [...project.fileNames],
        options: project.options,
        projectReferences: project.projectReferences,
      });
      expect(
        ts.getPreEmitDiagnostics(oracle).map((item) => item.code),
      ).toContain(diagnostic);
    },
  );
});
