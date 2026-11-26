import { utimes, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { afterEach, expect, it } from 'vitest';
import {
  AnalysisObserver,
  runWithProfile,
} from '../application/analysis/observability';
import type { AnalysisSnapshot } from '../core/analysis-cache/contracts';
import { NativeAnalysisCache } from '../core/analysis-cache/native-cache';
import { parseAnalysisSnapshot } from '../core/analysis-cache/snapshot-schema';
import {
  createTypeScriptDependencyContext,
  createWorkspaceSourceBoundary,
  type TypeScriptSemanticDependencyContext,
  type TypeScriptSemanticProject,
} from '../core/typescript-semantic';
import { roundTripAnalysisSnapshot } from './helpers/analysis-snapshot';
import { readFixtureSourceCoverage } from './helpers/native-coverage';
import { createSemanticRepairFixture } from './helpers/semantic-repair';

type Fixture = Awaited<ReturnType<typeof createSemanticRepairFixture>>;

const cleanups: Fixture['cleanup'][] = [];
const identity = 'bounded-observation-scheduling';
const configVersion = 'fixture-config';
const compilerOptions = {
  composite: true,
  module: 'ESNext',
  moduleResolution: 'Bundler',
  noLib: true,
  types: [],
};

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(
  files: Record<string, string>,
  types: string[] = [],
): Promise<Fixture> {
  const result = await createSemanticRepairFixture({
    'tsconfig.json': JSON.stringify({
      compilerOptions: { ...compilerOptions, types },
      files: ['entry.ts', 'peer.ts'],
    }),
    ...files,
  });
  cleanups.push(result.cleanup);
  return result;
}

function project(
  fixture: Fixture,
  producerConfigs: string[] = [],
): TypeScriptSemanticProject {
  const configPath = fixture.path('tsconfig.json');
  const files = [
    configPath,
    ...producerConfigs.map((name) => fixture.path(name)),
  ];
  const parsed = fixture.parse();
  expect(parsed.errors).toEqual([]);
  return {
    configPath,
    options: parsed.options,
    fileNames: parsed.fileNames,
    projectReferences: parsed.projectReferences,
    admissionMode: 'coverage-bounded',
    compilationObligationScope: 'generated-declaration-project-v1',
    analysisBinding: { phase: 'locked', checker: 'tsc' },
    workspaceSourceBoundary: createWorkspaceSourceBoundary(
      parsed.fileNames,
      undefined,
      readFixtureSourceCoverage(files),
    ),
  };
}

function analyze(
  project: TypeScriptSemanticProject,
  previous?: AnalysisSnapshot,
) {
  const cache = new NativeAnalysisCache(identity, previous, configVersion);
  const { configPath } = project;
  cache.configClosures.set(configPath, [configPath]);
  cache.inputs.observeConfig([{ filePath: configPath }]);
  const observer = new AnalysisObserver(
    'graph dependency analysis',
    performance.now(),
  );
  const context = runWithProfile(observer, () =>
    cache.epoch.run(
      () =>
        cache.restoreContext(project) ??
        createTypeScriptDependencyContext(project, { analysisCache: cache }),
    ),
  );
  observer.stop(true);
  const profile = observer.snapshot();
  return {
    cache,
    context,
    programs: profile.work.filter(
      ({ op, end }) => op === 'native-program-create' && end === 'computed',
    ).length,
    observedRoots: profile.metrics
      .filter(({ key }) => key === 'program-roots')
      .reduce((total, record) => total + record.value, 0),
  };
}

function published(cache: NativeAnalysisCache): AnalysisSnapshot {
  const snapshot = cache.snapshot();
  snapshot.header.baselineTime = Date.now();
  const parsed = parseAnalysisSnapshot(
    roundTripAnalysisSnapshot(snapshot),
    identity,
    configVersion,
  );
  expect(parsed).toBeDefined();
  return parsed!;
}

function referenceTargets(
  context: TypeScriptSemanticDependencyContext,
  file: string,
): (string | undefined)[] {
  return context
    .getImportRecords(file)
    .map(
      (record) =>
        context.getDependencyFact(record).referenceRequirement?.targetFileName,
    );
}

it('removes a cleared importer while retaining an independent source obligation', async () => {
  const f = await fixture({
    'entry.ts': 'export * from "./left.js";',
    'peer.ts': 'export * from "./right.js";',
    'left.ts': 'export const left = 1;',
    'right.ts': 'export const right = 1;',
    'tsconfig.producer.json': JSON.stringify({
      compilerOptions,
      files: ['left.ts', 'right.ts'],
    }),
  });
  const collect = (previous?: AnalysisSnapshot) =>
    analyze(project(f, ['tsconfig.producer.json']), previous);
  const entry = f.path('entry.ts');
  const peer = f.path('peer.ts');
  const seed = collect();
  expect(seed.programs).toBeGreaterThan(0);
  expect(seed.observedRoots).toBe(2 * seed.programs);
  expect(referenceTargets(seed.context, entry)).toEqual([f.path('left.ts')]);
  expect(referenceTargets(seed.context, peer)).toEqual([f.path('right.ts')]);
  const baseline = published(seed.cache);
  await writeFile(entry, 'export {};');
  const edited = new Date(baseline.header.baselineTime! + 2000);
  await utimes(entry, edited, edited);

  const warm = collect(baseline);
  expect(warm.programs).toBeGreaterThan(0);
  expect(warm.observedRoots).toBe(warm.programs);
  expect(referenceTargets(warm.context, entry)).toEqual([]);
  expect(referenceTargets(warm.context, peer)).toEqual([f.path('right.ts')]);

  const reopened = collect(published(warm.cache));
  expect(reopened.programs).toBe(0);
  expect(referenceTargets(reopened.context, entry)).toEqual([]);
  expect(referenceTargets(reopened.context, peer)).toEqual([
    f.path('right.ts'),
  ]);
});

it('reobserves a newly present path in a configured type declaration', async () => {
  const f = await fixture(
    {
      'entry.ts': 'export {};',
      'peer.ts': 'export {};',
      'support/index.d.ts': '/// <reference path="./later.d.ts" />\nexport {};',
    },
    ['./support/index'],
  );
  const selectLater = (context: TypeScriptSemanticDependencyContext) => {
    const snapshot = context.nativeEvidence!;
    const request = snapshot.requests.find(
      ({ specifier, channel }) =>
        specifier === './later.d.ts' && channel === 'path-directive',
    );
    expect(request).toBeDefined();
    return snapshot.resolutions.find(
      ({ requestId }) => requestId === request!.id,
    );
  };
  const seed = analyze(project(f));
  expect(selectLater(seed.context)?.pathSelection?.state).toBe('missing');
  const baseline = published(seed.cache);
  const late = f.path('support/later.d.ts');
  await writeFile(late, 'export {};');
  const old = new Date('2020-01-01T00:00:00.000Z');
  await utimes(late, old, old);

  const warm = analyze(project(f), baseline);
  const { contextDirty, resolutionDirty, semanticDirty, syntaxDirty } =
    warm.cache.invalidation;
  expect([
    contextDirty.size,
    resolutionDirty.size,
    semanticDirty.size,
    syntaxDirty.size,
  ]).toEqual([0, 0, 0, 0]);
  expect(warm.programs).toBeGreaterThan(0);
  expect(warm.observedRoots).toBe(warm.programs);
  expect(selectLater(warm.context)).toMatchObject({
    pathSelection: { state: 'selected' },
    target: { lexicalPath: late },
    compilerLoad: 'loaded',
  });
  expect(warm.context.hasSourceFile(late)).toBe(true);
});
