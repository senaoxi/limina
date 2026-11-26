import { resolveCheckerSourceModuleName } from '#checkers';
import type { NativeEvidenceSnapshot } from '../../domain/analysis/native-evidence';
import { hasQualifiedNativeContext } from '../analysis-cache/restored-context';
import { nativeDeclarationEvidence } from '../declaration-governance/evidence';
import type { ImportRecord } from '../import-analysis/records';
import { classifyImportRuntimeEvidence } from '../import-analysis/runtime-evidence';
import { isTypeScriptJsonSourcePath } from '../import-analysis/typescript-imports';
import { getResolvedTargetKind } from '../import-graph/declaration-classifier';
import type { TypeScriptSemanticDependencyContext } from '../typescript-semantic/contracts';
import type { NativeFileRequest } from '../typescript-semantic/native-file-requests';
import type { ProjectSemanticContext } from './contracts';
import type {
  ReferenceDependency,
  ReferenceGraphFacts,
} from './reference-facts';
import {
  isNativeProjectDependencyTarget,
  isTypeScriptSemanticSource,
} from './source-evidence';

type NativeReferenceProject = Pick<
  ProjectSemanticContext,
  'fileNames' | 'compilerOptions' | 'extensions' | 'analysisChecker'
>;

/** Current parsed roots prove membership. Only a compiler-bound SourceFile
 * with inventoried requests is an entry for the graph reader. */
function graphRoots(
  context: TypeScriptSemanticDependencyContext,
  fileNames: readonly string[],
  sources: ReadonlySet<string>,
) {
  const inventory = context.nativeInventory!;
  const bindings = new Map(
    inventory.roots.map((entry) => [entry.root, entry.source]),
  );
  if (bindings.size !== fileNames.length) return null;
  const active = new Set<string>();
  for (const file of fileNames) {
    const source = bindings.get(file);
    if (source === undefined) return null;
    if (isTypeScriptSemanticSource(file)) {
      if (sources.has(source)) active.add(source);
      continue;
    }
    // A JSON root remains a compiler member and can be an import target.
    // It can only be skipped as an importer when that membership is observed.
    if (
      !isTypeScriptJsonSourcePath(file) ||
      !isTypeScriptJsonSourcePath(source) ||
      !context.hasSourceFile(source) ||
      sources.has(source)
    )
      return null;
  }
  return active;
}

function graphEntries(
  context: TypeScriptSemanticDependencyContext,
  snapshot: NativeEvidenceSnapshot,
) {
  const sources = new Set(
    snapshot.requests.flatMap((request) =>
      request.sourceFile ? [request.sourceFile.lexicalPath] : [],
    ),
  );
  const loads = new Map(
    context.nativeInventory!.loads.map((load) => [load.requestId, load.source]),
  );
  const resolutions = new Map(
    snapshot.resolutions.map((resolution) => [
      resolution.requestId,
      resolution,
    ]),
  );
  const environment = snapshot.requests.flatMap((request) => {
    if (request.sourceFile !== null) return [];
    const file =
      loads.get(request.id) ?? resolutions.get(request.id)?.target?.lexicalPath;
    return file !== undefined && sources.has(file) ? [file] : [];
  });
  return { sources, loads, environment };
}

/** Project only current request-bearing sources. A stopped or cyclic path
 * cannot add a new entry. Compiler load aliases identify the SourceFile
 * supplying occurrences, independently of the lexical target of an edge. */
function reachableRequests(
  context: TypeScriptSemanticDependencyContext,
  snapshot: NativeEvidenceSnapshot,
  fileNames: readonly string[],
) {
  const { sources, loads, environment } = graphEntries(context, snapshot);
  const roots = graphRoots(context, fileNames, sources);
  if (roots === null) return null;
  const stops = new Set(
    snapshot.completeness
      .filter((partition) => partition.state === 'proven-stop')
      .map((partition) => partition.entryId),
  );
  const importers = new Map<string, readonly NativeFileRequest[]>();
  for (const entry of [...roots, ...environment]) {
    const pending = [entry];
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (importers.has(file)) continue;
      const occurrences = context.getNativeFileRequests!(file);
      importers.set(file, occurrences);
      for (const row of occurrences) {
        const source = loads.get(row.evidence.requestId);
        if (
          source !== undefined &&
          sources.has(source) &&
          row.expansion &&
          !stops.has(row.evidence.requestId)
        )
          pending.push(source);
      }
    }
  }
  const direct = [...roots].flatMap((file) => {
    const rows = importers.get(file)!;
    importers.delete(file);
    return rows;
  });
  return {
    direct,
    support: importers
      .values()
      .flatMap((rows) => rows.values())
      .toArray(),
  };
}

function isMissingRequest(
  record: ImportRecord,
  project: NativeReferenceProject,
): boolean {
  // A physically present resource or checker-only extension affects a missing
  // diagnostic. Its presence cannot establish a compiler reference.
  const input = {
    compilerOptions: project.compilerOptions,
    containingFile: record.filePath,
    extensions: [...project.extensions],
    specifier: record.specifier,
  };
  const supplemental = resolveCheckerSourceModuleName(input);
  return (
    supplemental === null &&
    classifyImportRuntimeEvidence({
      ...input,
      oxcResolvedFilePath: null,
      typeScriptResolution: null,
    }).classification !== 'resource'
  );
}

function graphDependency(
  row: NativeFileRequest,
): ReferenceDependency | undefined {
  if (!row.target || !isNativeProjectDependencyTarget(row.target))
    return undefined;
  if (row.typeEvidence?.kind === 'ambient' && row.referenceRequirement === null)
    return undefined;
  return {
    importRecord: row.record,
    nativeFact: { nativeEvidence: row.evidence },
    referenceRequirement: row.referenceRequirement,
    typeEvidence: row.typeEvidence,
    resolvedFilePath: row.target,
    targetKind: getResolvedTargetKind(row.target),
  };
}

function resolvedDependencies(rows: readonly NativeFileRequest[]) {
  return rows.flatMap((row) => {
    const dependency = graphDependency(row);
    return dependency ? [dependency] : [];
  });
}

function completedNativeEvidence(context: TypeScriptSemanticDependencyContext) {
  const snapshot = context.nativeEvidence;
  return snapshot?.run === 'completed' &&
    snapshot.failures.length === 0 &&
    snapshot.completeness.every((partition) => partition.state !== 'gap') &&
    snapshot.contexts[0]?.authority.phase === 'locked' &&
    hasQualifiedNativeContext(context)
    ? snapshot
    : undefined;
}

export function projectNativeReferenceFacts(
  context: TypeScriptSemanticDependencyContext,
  project: NativeReferenceProject,
): ReferenceGraphFacts | undefined {
  const snapshot = completedNativeEvidence(context);
  if (!snapshot || !context.getNativeFileRequests) return undefined;
  const requests = reachableRequests(context, snapshot, project.fileNames);
  if (requests === null) return undefined;
  const { direct, support } = requests;
  const rootDependencies = resolvedDependencies(direct);
  const supportDependencies = resolvedDependencies(support);
  const isRequired = (row: ReferenceDependency) =>
    row.referenceRequirement !== null;
  const requiredSupport = supportDependencies.filter(isRequired);
  const unresolvedNativeRecords = [...direct, ...support]
    .filter((row) => row.target === undefined)
    .map(({ record, evidence }) => ({ record, evidence }));
  return {
    dependencies: [...rootDependencies, ...supportDependencies],
    referenceInputs: [
      ...rootDependencies.filter(isRequired),
      ...requiredSupport,
    ],
    ownershipInputs: [...rootDependencies, ...requiredSupport],
    failures: [],
    observations: unresolvedNativeRecords
      .filter(({ record }) => isMissingRequest(record, project))
      .map(({ record }) => ({ kind: 'missing', importRecord: record })),
    unresolvedNativeRecords,
    nativeEvidence: snapshot,
    declarationEvidence: nativeDeclarationEvidence(
      snapshot,
      project.analysisChecker,
    ),
  };
}
