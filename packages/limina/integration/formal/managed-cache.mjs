import assert from 'node:assert/strict';
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import {
  readStoredAnalysisSnapshot,
  writeStoredAnalysisSnapshot,
} from '../../src/__tests__/helpers/analysis-snapshot.ts';
import { loadConfig } from '../../src/config/loader.ts';
import { AnalysisCacheStore } from '../../src/preflight/analysis-cache-store.ts';
import { LiminaPreflightManager } from '../../src/preflight/manager.ts';
import { executeCheckerBuildTargets } from '../../src/typecheck/checker/build-execution.ts';
import { createCheckerTarget } from '../../src/typecheck/targets.ts';

// A fresh caller-owned directory keeps even failed replays inspectable.
assert.ok(process.argv[2], 'provide a new output directory');
mkdirSync(process.argv[2]);
const out = realpathSync.native(process.argv[2]);
const temporary = mkdtempSync(path.join(tmpdir(), 'limina-bridge-'));
const fixture = realpathSync.native(temporary);
async function replay() {
  cpSync(
    new URL(
      '../../fixtures/detectors/checker/admission-denied-reference/repo/',
      import.meta.url,
    ),
    fixture,
    { recursive: true },
  );
  const file = (n) => path.join(fixture, n);
  const portable = (n) => file(n).split(path.sep).join('/');
  writeFileSync(
    file('pnpm-lock.yaml'),
    "lockfileVersion: '9.0'\nimporters:\n  .: {}\n",
  );
  // The fixture config is plain ESM; avoid involving a TypeScript config loader in the cache oracle.
  renameSync(file('limina.config.mts'), file('limina.config.mjs'));
  const reports = [];
  async function launch(label, cacheBlockReadFilter) {
    const config = await loadConfig({ configPath: file('limina.config.mjs') });
    const events = [];
    const manager = new LiminaPreflightManager({
      config,
      analysisCache: true,
      cacheBlockReadFilter,
      metrics: {
        record: (event) => {
          events.push(event);
        },
      },
    });
    try {
      const { graph } = await manager.ensureGeneratedArtifactsMaterialized();
      const checker = graph.checkers.find((c) => c.name === 'tsc');
      const name = 'tsconfig.a.json';
      const projection = graph.sourceToBuild.get('tsc').get(portable(name));
      const declarationConfig = graph.sourceToDts
        .get('tsc')
        .get(portable(name));
      const references = JSON.parse(
        readFileSync(projection.path, 'utf8'),
      ).references;
      const metric = (kind) =>
        events.find((event) => event.kind === kind)?.count ?? 0;
      const target = createCheckerTarget({
        checker,
        configPath: projection.path,
        executionKind: 'build',
        projectRootDir: fixture,
        sourceConfigPath: portable(name),
      });
      const launched = [];
      const result = await executeCheckerBuildTargets({
        allCheckers: graph.checkers,
        config,
        flowDepth: 0,
        generatedGraph: graph,
        label: 'formal replay',
        preflight: manager,
        projectRootDir: fixture,
        targets: [target],
        workspaceContext: await manager.ensureWorkspaceValidated(),
        runnerOptions: {
          config,
          report: { defer: true },
          runner: (t) => {
            launched.push(t.id);
            return { configPath: t.configPath, status: 0 };
          },
        },
      });
      await manager.publishAnalysisCache();
      const store = new AnalysisCacheStore({
        namespace: manager.artifactNamespace,
        configPath: config.configPath,
        identity: 'path only',
      });
      const record = {
        label,
        owner: graph.manifest.ownership.configs.find((c) => c.config === name)
          ?.owner,
        refs: references,
        declarationRefs: JSON.parse(readFileSync(declarationConfig, 'utf8'))
          .references,
        graphBuilds: metric('graphBuilds'),
        restoredContexts: metric('restoredContexts'),
        semanticPrograms: metric('semanticPrograms'),
        launched,
        failures: result.failedTargets.map((t) => ({
          stage: t.admission?.stage,
          decision: t.admission?.decision,
          diagnostics: t.admission?.diagnostics?.map((d) => d.code),
        })),
      };
      reports.push(record);
      writeFileSync(
        path.join(out, 'observations.json'),
        `${JSON.stringify(reports, null, 2)}\n`,
      );
      return { record, index: store.path, declarationConfig };
    } finally {
      manager.dispose();
    }
  }
  const { index, declarationConfig, record: cold } = await launch('cold');
  const { record: warm } = await launch('warm');
  assert.equal(cold.restoredContexts, 0);
  assert.ok(cold.semanticPrograms > 0);
  assert.ok(warm.restoredContexts > 0);
  assert.equal(warm.semanticPrograms, 0);

  const fullIndex = readFileSync(index);
  const snapshotBeforeFilter = readStoredAnalysisSnapshot(index);
  const scopes = new Set(
    Object.values(snapshotBeforeFilter.contexts).map(
      (context) => context.project.configPath,
    ),
  );
  const { record: included } = await launch('included-scopes', { scopes });
  assert.ok(included.restoredContexts > 0);
  assert.equal(included.semanticPrograms, 0);
  assert.deepEqual(readFileSync(index), fullIndex);
  const { record: excluded } = await launch('excluded-scopes', {
    scopes: new Set(),
  });
  assert.equal(excluded.restoredContexts, 0);
  assert.ok(excluded.semanticPrograms > 0);
  assert.deepEqual(readFileSync(index), fullIndex);

  const bytes = readFileSync(declarationConfig, 'utf8');
  const declaration = JSON.parse(bytes);
  assert.equal(declaration.references.length, 1);
  declaration.references = [];
  writeFileSync(declarationConfig, JSON.stringify(declaration));
  const { record: repaired } = await launch('wrong-materialized-closure');
  assert.ok(repaired.restoredContexts > 0);
  assert.equal(repaired.semanticPrograms, 0);
  assert.equal(readFileSync(declarationConfig, 'utf8'), bytes);

  const snapshot = readStoredAnalysisSnapshot(index);
  const source = portable('a.ts');
  const contexts = Object.values(snapshot.contexts).filter(
    (context) =>
      context.project.configPath === portable('tsconfig.a.json') &&
      Object.hasOwn(context.sources, source),
  );
  assert.ok(contexts.length > 0, 'expected complete facts for the consumer');
  for (const context of contexts) delete context.sources[source];
  writeStoredAnalysisSnapshot(index, snapshot);
  const { record: recollected } = await launch('missing-source-facts');
  assert.ok(recollected.semanticPrograms > 0);
  const { record: reopened } = await launch('reopened');
  assert.ok(reopened.restoredContexts > 0);
  assert.equal(reopened.semanticPrograms, 0);
  for (const record of [
    cold,
    warm,
    included,
    excluded,
    repaired,
    recollected,
    reopened,
  ]) {
    assert.equal(record.graphBuilds, 1);
    assert.equal(record.owner, 'tsc');
    assert.equal(record.refs.length, 1);
    assert.deepEqual(record.refs, cold.refs);
    assert.deepEqual(record.declarationRefs, cold.declarationRefs);
    assert.deepEqual(record.launched, []);
    assert.deepEqual(record.failures, [
      {
        stage: 'mutation',
        decision: 'denied',
        diagnostics: ['LIMINA_GRAPH_ACCESS_DENIED'],
      },
    ]);
  }
  // Same target, real policy selection changed: proves the runner observer works.
  const leafFile = file('tsconfig.a.json');
  const config = JSON.parse(readFileSync(leafFile, 'utf8'));
  config.liminaOptions.graphRules = [];
  writeFileSync(leafFile, JSON.stringify(config));
  const { record: allowed } = await launch('unselected-label');
  assert.equal(allowed.launched.length, 1);
  assert.deepEqual(allowed.failures, []);
  const beforeChange = readFileSync(index);
  appendFileSync(source, '\nexport const changed = 1;\n');
  const { record: partial } = await launch('changed-input-scoped', {
    scopes: new Set(),
  });
  assert.ok(partial.semanticPrograms > 0);
  assert.equal(partial.launched.length, 1);
  assert.deepEqual(
    readFileSync(index),
    beforeChange,
    'partial restore replaced the full index',
  );
  const { record: full } = await launch('changed-input-full');
  assert.ok(full.semanticPrograms > 0);
  assert.equal(full.launched.length, 1);
  assert.notDeepEqual(
    readFileSync(index),
    beforeChange,
    'eligible full writer did not publish the change',
  );
}
try {
  await replay();
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
