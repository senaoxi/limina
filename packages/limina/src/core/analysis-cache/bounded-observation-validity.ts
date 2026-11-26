import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import { reachableNativeSources } from '../typescript-semantic/native-program-inclusions';
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
    hasBoundPremises(record, importers),
    hasBoundInclusions(record, members),
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
  const rootNames = new Set(record.project.fileNames);
  const partitions = snapshot.completeness.filter(
    (entry) => entry.channel === 'implicit' && rootNames.has(entry.entryId),
  );
  const observed = partitions.filter((entry) =>
    ['observed', 'restored'].includes(entry.state),
  );
  return [
    roots.size === inventory.roots.length,
    roots.size === new Set(observed.map((entry) => entry.entryId)).size,
    observed.every((entry) => members.has(roots.get(entry.entryId) ?? '')),
    !record.complete ||
      (partitions.length === rootNames.size &&
        new Set(partitions.map((entry) => entry.entryId)).size ===
          rootNames.size),
  ].every(Boolean);
}

function hasBoundPremises(
  record: NativeContextRecord,
  importers: Record<string, ImporterRecord>,
): boolean {
  const { inventory, snapshot } = record.native!;
  const modules = new Map(
    inventory.modules.map((entry) => [entry.requestId, entry]),
  );
  const paths = new Set(inventory.paths.map((entry) => entry.requestId));
  const resolutions = new Map(
    snapshot.resolutions.map((entry) => [entry.requestId, entry]),
  );
  const hasReferences = (record.project.projectReferences?.length ?? 0) > 0;
  const options = nativeFingerprint(record.project.options);
  const occurrences = new Map(
    Object.values(record.sources).flatMap((id) => {
      const importer = id === null ? undefined : importers[id];
      return (importer?.occurrences ?? []).flatMap((occurrence) => {
        const requestId =
          importer?.facts[occurrenceKey(occurrence)]?.nativeEvidence?.requestId;
        return requestId === undefined
          ? []
          : [[requestId, occurrence] as const];
      });
    }),
  );
  return (
    modules.size === inventory.modules.length &&
    paths.size === inventory.paths.length &&
    snapshot.requests.every((request) => {
      const module = modules.get(request.id);
      const isPath = paths.delete(request.id);
      if (isPath !== (request.channel === 'path-directive')) return false;
      if (module === undefined)
        return (
          !['implicit', 'module'].includes(request.channel) ||
          request.sourceFile === null
        );
      modules.delete(request.id);
      const occurrence = occurrences.get(request.id);
      const resolution = resolutions.get(request.id);
      return (
        ['implicit', 'module'].includes(request.channel) &&
        occurrence !== undefined &&
        request.sourceFile !== null &&
        (occurrence.kind === 'module-augmentation') ===
          (module.role === 'augmentation') &&
        (module.mode === undefined ? null : String(module.mode)) ===
          request.resolutionMode &&
        (module.targetExtension !== undefined) ===
          (resolution?.state === 'resolved') &&
        (resolution?.target !== null ||
          module.ownAmbient === (resolution.state === 'ambient')) &&
        module.options !== undefined &&
        (hasReferences || nativeFingerprint(module.options) === options)
      );
    }) &&
    modules.size === 0 &&
    paths.size === 0
  );
}

function hasBoundInclusions(
  record: NativeContextRecord,
  members: Set<string>,
): boolean {
  const { inventory, snapshot } = record.native!;
  const inclusions = inventory.inclusions;
  if (inclusions === undefined) return true;
  const requests = new Map(snapshot.requests.map((entry) => [entry.id, entry]));
  if (
    new Set(inclusions.projectReferences).size !==
      inclusions.projectReferences.length ||
    (inclusions.projectReferences.length > 0 &&
      (record.project.projectReferences?.length ?? 0) === 0) ||
    new Set(inclusions.requests.map((item) => item.requestId)).size !==
      inclusions.requests.length ||
    inclusions.requests.some(
      (item) => !requests.has(item.requestId) || !members.has(item.source),
    )
  )
    return false;
  const includeByParent = Map.groupBy(
    inclusions.requests,
    ({ requestId }) => requests.get(requestId)!.sourceFile?.lexicalPath ?? null,
  );
  const seeds = [
    ...inventory.roots.map((entry) => entry.source),
    ...inclusions.projectReferences,
    ...(includeByParent.get(null) ?? []).map((item) => item.source),
  ];
  const reachable = reachableNativeSources(seeds, (file) =>
    (includeByParent.get(file) ?? []).map(({ source }) => source),
  );
  return reachable.size === members.size && reachable.isSubsetOf(members);
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
