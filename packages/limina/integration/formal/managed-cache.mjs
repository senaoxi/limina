import assert from 'node:assert/strict';
import {
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
  decodeGraphProjection,
  encodeGraphProjection,
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
  // The fixture config is plain ESM; avoid involving a TypeScript config loader in the cache oracle.
  renameSync(file('limina.config.mts'), file('limina.config.mjs'));
  const reports = [];
  async function launch(label) {
    const config = await loadConfig({ configPath: file('limina.config.mjs') });
    const events = [];
    const manager = new LiminaPreflightManager({
      config,
      analysisCache: true,
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
      const references = JSON.parse(
        readFileSync(projection.path, 'utf8'),
      ).references;
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
        hit: events.some(
          (event) => event.kind === 'graphHits' && event.count > 0,
        ),
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
      return { record, index: store.path };
    } finally {
      manager.dispose();
    }
  }
  const { index, record: cold } = await launch('cold');
  const { record: warm } = await launch('warm');
  assert.equal(cold.hit, false);
  assert.equal(warm.hit, true);
  // Remove the required serialized edge inside a valid block/index envelope.
  const snapshot = readStoredAnalysisSnapshot(index);
  const records = Object.values(snapshot.graphs);
  assert.equal(records.length, 1);
  const projection = decodeGraphProjection(records[0].data);
  const leaf = [...projection.generatedFiles].find(
    ([p, s]) => p.endsWith('.dts.json') && JSON.parse(s).references?.length,
  );
  assert.ok(leaf, 'positive serialized reference control');
  projection.generatedFiles.set(
    leaf[0],
    JSON.stringify({ ...JSON.parse(leaf[1]), references: [] }),
  );
  records[0].data = encodeGraphProjection(projection);
  writeStoredAnalysisSnapshot(index, snapshot);
  const { record: repaired } = await launch('wrong-closure');
  assert.equal(repaired.hit, false);
  const { record: reopened } = await launch('reopened');
  assert.equal(reopened.hit, true);
  for (const record of [cold, warm, repaired, reopened]) {
    assert.equal(record.owner, 'tsc');
    assert.equal(record.refs.length, 1);
    assert.deepEqual(record.refs, cold.refs);
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
}
try {
  await replay();
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
