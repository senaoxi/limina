import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import type { ImporterRecord, NativeContextRecord } from './contracts';
import { occurrenceKey } from './semantic-state';

/** Validate consumer projections against the receipt captured from the live
 * compiler, including import-free members and redirected load aliases. */
export function hasBoundCompilerObservations(
  record: NativeContextRecord,
  importers: Record<string, ImporterRecord>,
): boolean {
  const inventory = record.native!.inventory;
  if (inventory === undefined) return false;
  const members = new Set(inventory.members);
  const sources = Object.keys(record.sources);
  return [
    members.size === inventory.members.length,
    members.size === sources.length,
    sources.every((file) => members.has(file)),
    hasBoundLoads(record, members),
    hasBoundRoots(record, members),
    hasBoundOccurrences(record, importers),
  ].every(Boolean);
}

function hasBoundLoads(record: NativeContextRecord, members: Set<string>) {
  const { inventory, snapshot } = record.native!;
  const loads = new Map(inventory.loads.map((load) => [load.requestId, load]));
  const observed = snapshot.resolutions.filter(
    (resolution) => resolution.compilerLoad === 'loaded',
  );
  return [
    loads.size === inventory.loads.length,
    loads.size === observed.length,
    observed.every((resolution) => {
      const load = loads.get(resolution.requestId);
      return (
        load !== undefined &&
        [
          load.target === resolution.target?.lexicalPath,
          members.has(load.source),
        ].every(Boolean)
      );
    }),
  ].every(Boolean);
}

function hasBoundRoots(record: NativeContextRecord, members: Set<string>) {
  const { inventory, snapshot } = record.native!;
  const roots = new Map(
    inventory.roots.map((entry) => [entry.root, entry.source]),
  );
  const observed = snapshot.completeness.filter(
    (entry) =>
      entry.state === 'observed' &&
      entry.channel === 'implicit' &&
      record.project.fileNames.includes(entry.entryId),
  );
  return [
    roots.size === inventory.roots.length,
    roots.size === new Set(observed.map((entry) => entry.entryId)).size,
    observed.every((entry) => members.has(roots.get(entry.entryId) ?? '')),
  ].every(Boolean);
}

function hasBoundOccurrences(
  record: NativeContextRecord,
  importers: Record<string, ImporterRecord>,
): boolean {
  const occurrences = record.native!.inventory.occurrences;
  const expected = new Map(
    occurrences.map((entry) => [entry.requestId, entry.fingerprint]),
  );
  const requests = new Map(
    record.native!.snapshot.requests.map((request) => [request.id, request]),
  );
  const sources = Object.values(record.sources).map((id) =>
    id === null ? undefined : importers[id],
  );
  if (sources.includes(undefined)) return false;
  const retained = sources.flatMap((importer) =>
    importer!.occurrences.map((occurrence) => ({
      requestId:
        importer!.facts[occurrenceKey(occurrence)]?.nativeEvidence?.requestId,
      record: occurrence,
    })),
  );
  return [
    expected.size === occurrences.length,
    expected.size === retained.length,
    retained.every(
      (entry) =>
        entry.requestId !== undefined &&
        expected.get(entry.requestId) ===
          nativeFingerprint([requests.get(entry.requestId), entry.record]),
    ),
  ].every(Boolean);
}
