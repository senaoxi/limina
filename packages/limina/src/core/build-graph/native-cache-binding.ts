import { compareCodeUnits } from '#utils/collections';
import type { NativeEvidenceSnapshot } from '../../domain/analysis/native-evidence';
import type {
  ImporterRecord,
  NativeContextRecord,
} from '../analysis-cache/contracts';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import type { StoredGraphData } from './analysis-cache-schema';
import { hasBoundCandidate } from './cached-candidate-binding';
import { hasBoundNativeOwnership } from './native-cache-ownership';

const fields = [
  'contexts',
  'coverageIndexes',
  'coverage',
  'requests',
  'traversal',
  'resolutions',
  'relations',
  'obligations',
  'completeness',
  'failures',
] as const;

/**
 * Graph records cannot confer qualifications absent from validated contexts.
 */
export function hasBoundNativeGraph(
  graph: StoredGraphData,
  records: Readonly<Record<string, NativeContextRecord>>,
  importers: Readonly<Record<string, ImporterRecord>>,
): boolean {
  const snapshots = graph.dependencyAnalysis.nativeEvidence?.map(
    (entry) => entry.snapshot,
  );
  if (snapshots === undefined) return false;
  return [
    hasBoundCandidate(graph),
    hasMatchingNativeRecords(snapshots, records),
    hasBoundNativeOwnership({ graph, contexts: records, importers }),
  ].every(Boolean);
}

function hasMatchingNativeRecords(
  snapshots: readonly NativeEvidenceSnapshot[],
  records: Readonly<Record<string, NativeContextRecord>>,
): boolean {
  const identities = new Set(
    snapshots.flatMap((snapshot) =>
      snapshot.contexts.map((context) => context.id),
    ),
  );
  const retained = Object.values(records)
    .flatMap((record) =>
      record.native === undefined ? [] : [record.native.snapshot],
    )
    .filter((snapshot) => identities.has(snapshot.contexts[0]!.id));
  return fields.every(
    (field) => recordSet(snapshots, field) === recordSet(retained, field),
  );
}

function recordSet(
  snapshots: readonly NativeEvidenceSnapshot[],
  field: (typeof fields)[number],
): string {
  const identities = new Set(
    snapshots.flatMap((snapshot) => snapshot[field].map(nativeFingerprint)),
  );
  return nativeFingerprint([...identities].sort(compareCodeUnits));
}
