import assert from 'node:assert/strict';
import type { StoredGraphData } from '../../core/build-graph/analysis-cache-schema';
import {
  decodeGraphProjection,
  encodeGraphProjection,
  readStoredAnalysisSnapshot,
  writeStoredAnalysisSnapshot,
} from './analysis-snapshot';

export type FrameworkCacheCorruption =
  | 'schedule occurrence'
  | 'locked occurrence'
  | 'candidate schedule'
  | 'manifest bytes';

export function corruptFrameworkSnapshot(
  file: string,
  fault: FrameworkCacheCorruption,
): void {
  const snapshot = readStoredAnalysisSnapshot(file);
  const graph = Object.values(snapshot.graphs)[0];
  assert.ok(graph, 'Expected a persisted framework graph.');
  const projection = decodeGraphProjection(graph.data) as StoredGraphData;
  const schedule = projection.dependencyEdges.find(
    (edge) => edge.kind === 'framework-schedule',
  );
  assert.ok(schedule, 'The fixture must contain a framework scheduling edge.');
  switch (fault) {
    case 'locked occurrence': {
      const facts = projection.ownershipPlan.dependencyFacts;
      const occurrence = facts.findIndex(
        (fact) =>
          fact.consumerConfigPath === schedule.fromConfigPath &&
          fact.importRecord.specifier === schedule.importedSpecifier,
      );
      assert.ok(
        occurrence !== -1,
        'The schedule must have an original locked fact.',
      );
      facts.splice(occurrence, 1);
      break;
    }
    case 'candidate schedule': {
      const candidate = projection.dependencyAnalysis.candidate;
      assert.ok(candidate?.schedules.length, 'Expected an admitted schedule.');
      projection.dependencyAnalysis.candidate = { ...candidate, schedules: [] };
      break;
    }
    case 'manifest bytes': {
      const manifest = structuredClone(projection.manifest);
      const target = manifest.targets.framework[0];
      assert.ok(target, 'Expected a framework execution target.');
      target.executionConfig = 'consumer/tsconfig.forged-check.json';
      replaceGeneratedManifest(projection, manifest);
      break;
    }
    case 'schedule occurrence': {
      const manifest = projection.manifest;
      const edge = manifest.dependencyEdges.find(
        (entry) =>
          entry.kind === 'framework-schedule' &&
          entry.importedSpecifier === schedule.importedSpecifier &&
          entry.file === schedule.file,
      );
      assert.ok(edge, 'Expected the same occurrence in the manifest.');
      schedule.importedSpecifier = './incorrect-dependency.js';
      edge.importedSpecifier = schedule.importedSpecifier;
      replaceGeneratedManifest(projection, manifest);
      break;
    }
  }
  graph.data = encodeGraphProjection(projection);
  writeStoredAnalysisSnapshot(file, snapshot);
}

function replaceGeneratedManifest(
  projection: StoredGraphData,
  manifest: StoredGraphData['manifest'],
): void {
  projection.generatedFiles = new Map(projection.generatedFiles).set(
    projection.manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}
