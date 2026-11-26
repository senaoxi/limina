import ts from 'typescript';
import type { NativeFileIdentity } from '../../domain/analysis/native-coverage';
import type {
  NativeCompletenessPartition,
  NativeEvidenceSnapshot,
  NativeRequest,
  NativeResolution,
} from '../../domain/analysis/native-evidence';
import { freezeNativeData } from '../../domain/analysis/native-evidence-freeze';
import type { NativeCompilationObligation } from '../../domain/analysis/native-obligation';
import type { ImportRecord } from '../import-analysis/records';
import type { FileDependencyFacts } from './file-dependency-facts';
import type {
  NativeContextInventory,
  NativeModulePremises,
  NativePathPremises,
} from './native-context-inventory';
import { NativeDependencyContext } from './native-dependency-context';
import {
  hasSameNativeFileBinding,
  nativeFingerprint,
} from './native-file-identity';
import type { NativeObservationAdapter } from './native-observation-adapter';
import { createNativePathObligation } from './native-path-obligations';
import { physicalTarget } from './native-path-selection';
import { projectNativeProgramFacts } from './native-program-facts';
import type { NativeSourceAttempt } from './native-program-frontier';
import { reachableNativeSources } from './native-program-inclusions';
import { projectNativeModuleObligation } from './native-program-obligations';
import type { NativeRequestRecord } from './native-program-records';
import type { NativeRequestResult } from './native-program-request-data';
import {
  assembleNativeSnapshot,
  nativeRequestPartition,
  observedCoverage,
} from './native-program-snapshot';
import { remainingNativeObligations } from './native-request-obligations';
import {
  type NativeReferenceObservation,
  observedDeclarationRedirect,
  observeNativeReference,
} from './reference-redirect';
import type { ResolutionOrigin } from './resolution-origin';

export interface NativeObservationRow {
  entry: NativeRequestResult;
  partition: NativeCompletenessPartition;
  module?: NativeModulePremises;
  path?: NativePathPremises;
  include?: string;
  load?: string;
  record?: ImportRecord;
  origin?: ResolutionOrigin;
}

export interface ComposedNativeMember {
  file: string;
  rows: readonly NativeObservationRow[];
  syntax?: FileDependencyFacts;
  restored: boolean;
}

interface Composition {
  adapter: NativeObservationAdapter;
  roots: NativeContextInventory['roots'];
  partitions: readonly NativeCompletenessPartition[];
  members: readonly ComposedNativeMember[];
  environment: readonly NativeObservationRow[];
  projectReferenceMembers: readonly string[];
}

interface CurrentRow {
  row: NativeObservationRow;
  entry: NativeRequestResult;
  load?: string;
  include?: string;
  attempt?: NativeSourceAttempt;
}

export function projectComposedNativeContext(
  input: Composition,
): NativeDependencyContext | undefined {
  const { adapter } = input;
  const members = new Set(input.members.map(({ file }) => file));
  const rows = [
    ...input.members.flatMap((member) => member.rows),
    ...input.environment,
  ];
  if (!hasQualifiedSourceClassifications(input, rows, members))
    return undefined;
  const current = currentRows(input, rows, members);
  if (current === undefined) return undefined;
  const entries = current.map(({ entry }) => entry);
  const references = currentReferences(adapter, entries);
  const obligations = projectObligations(adapter, current, references);
  if (obligations === undefined) return undefined;

  const evidence = composeEvidence(input, current, obligations);
  const records = current.flatMap(({ row, entry }): NativeRequestRecord[] =>
    row.record === undefined
      ? []
      : [{ request: entry.request, record: row.record }],
  );
  const origins = new Map(
    current.map(({ row, entry }) => [entry.request.id, row.origin]),
  );
  const syntax = new Map(
    input.members.flatMap(({ file, syntax }) =>
      syntax === undefined ? [] : [[file, syntax] as const],
    ),
  );
  adapter.frontier.identities.assertStable();
  return new NativeDependencyContext(adapter.options, adapter, undefined, {
    evidence,
    records,
    syntax,
    inventory: composedInventory(input, current, records, syntax),
    facts: projectNativeProgramFacts({
      snapshot: evidence,
      frontier: adapter.frontier,
      references,
      entries: records,
      origin: (id) => origins.get(id),
    }),
  });
}

function currentRows(
  input: Composition,
  rows: readonly NativeObservationRow[],
  members: ReadonlySet<string>,
): CurrentRow[] | undefined {
  const { adapter } = input;
  const { frontier } = adapter;
  const aliases = loadAliases(rows, input.roots, members, frontier.fileKey);
  if (aliases === undefined) return undefined;
  const actualAttempts = new Map(
    frontier.attempts.map((attempt) => [attempt.file.lexicalPath, attempt]),
  );
  const ids = new Set<string>();
  const current: CurrentRow[] = [];
  for (const row of rows) {
    const request = currentRequest(adapter, row.entry.request);
    const target = currentFile(adapter, row.entry.resolution.target);
    if (request === undefined || target === undefined || ids.has(request.id))
      return undefined;
    ids.add(request.id);
    const include =
      row.include !== undefined && members.has(row.include)
        ? row.include
        : undefined;
    const load =
      target === null
        ? undefined
        : aliases.get(frontier.fileKey(target.lexicalPath));
    const attempt =
      target === null
        ? undefined
        : (actualAttempts.get(target.lexicalPath) ??
          inheritedAttempt(adapter, row, target, include));
    if (
      !canReuseAttempt(row, attempt, load) ||
      !hasQualifiedStop(row, members, adapter.options.project.options)
    )
      return undefined;
    const resolution: NativeResolution = {
      ...row.entry.resolution,
      requestId: request.id,
      evidenceIds: [request.id],
      target,
      compilerLoad:
        load === undefined
          ? attempt === undefined
            ? 'not-observed'
            : 'attempted'
          : 'loaded',
    };
    current.push({
      row,
      entry: { request, resolution },
      load,
      include,
      attempt,
    });
  }
  return current;
}

function loadAliases(
  rows: readonly NativeObservationRow[],
  roots: NativeContextInventory['roots'],
  members: ReadonlySet<string>,
  fileKey: (file: string) => string,
): Map<string, string> | undefined {
  const aliases = new Map([...members].map((file) => [fileKey(file), file]));
  const pairs = [
    ...roots.map(({ root, source }) => [root, source] as const),
    ...rows.flatMap(({ entry, load }) =>
      load === undefined ||
      !members.has(load) ||
      entry.resolution.target === null
        ? []
        : [[entry.resolution.target.lexicalPath, load] as const],
    ),
  ];
  for (const [alias, source] of pairs) {
    const key = fileKey(alias);
    const prior = aliases.get(key);
    if (prior !== undefined && prior !== source) return undefined;
    aliases.set(key, source);
  }
  return aliases;
}

function inheritedAttempt(
  { frontier }: NativeObservationAdapter,
  row: NativeObservationRow,
  target: NativeFileIdentity,
  include: string | undefined,
): NativeSourceAttempt | undefined {
  return row.entry.resolution.compilerLoad === 'attempted' ||
    (include === undefined && row.include !== undefined)
    ? frontier.inspect(target.lexicalPath)
    : undefined;
}

function canReuseAttempt(
  row: NativeObservationRow,
  attempt: NativeSourceAttempt | undefined,
  load: string | undefined,
): boolean {
  return (
    load !== undefined ||
    row.entry.resolution.target === null ||
    row.partition.state !== 'proven-stop' ||
    attempt?.decision.action !== 'expand' ||
    ['resolution-disabled', 'observation-unavailable'].includes(
      row.partition.stopReason,
    )
  );
}

function hasQualifiedStop(
  { entry, include, load, module }: NativeObservationRow,
  members: ReadonlySet<string>,
  options: ts.CompilerOptions,
): boolean {
  if (include !== undefined || load === undefined || members.has(load))
    return true;
  return module === undefined
    ? entry.request.channel === 'type-directive' &&
        entry.request.sourceFile !== null &&
        options.noResolve === true
    : module.role === 'augmentation' ||
        module.options?.noResolve === true ||
        module.excludedDocumentation;
}

function currentRequest(
  adapter: NativeObservationAdapter,
  original: NativeRequest,
): NativeRequest | undefined {
  const context = adapter.options.context;
  if (original.consumerContextId === context.id) return original;
  if (original.predecessorId !== null) return undefined;
  const source = currentFile(adapter, original.sourceFile);
  if (source === undefined) return undefined;
  const entry =
    original.entry.kind === 'source'
      ? source === null
        ? undefined
        : { ...original.entry, file: source }
      : original.entry;
  if (entry === undefined) return undefined;
  const id = nativeFingerprint([
    context.id,
    source?.lexicalPath,
    entry.kind === 'source' ? entry.position : -1,
    original.channel,
    original.specifier,
    original.resolutionMode === null
      ? undefined
      : Number(original.resolutionMode),
  ]);
  return {
    ...original,
    id,
    consumerContextId: context.id,
    origin: { source: 'typescript-observation', family: 'typescript', context },
    sourceFile: source,
    entry,
  };
}

function currentFile(
  { frontier }: NativeObservationAdapter,
  previous: NativeFileIdentity | null,
): NativeFileIdentity | null | undefined {
  if (previous === null) return null;
  const current = frontier.identities.read(previous.lexicalPath);
  return hasSameNativeFileBinding(previous, current) ? current : undefined;
}

function hasQualifiedSourceClassifications(
  input: Composition,
  rows: readonly NativeObservationRow[],
  members: ReadonlySet<string>,
): boolean {
  const inputRows = rows.filter(
    ({ entry, include }) =>
      include !== undefined &&
      members.has(include) &&
      entry.resolution.externalLibrary !== true,
  );
  const edges = Map.groupBy(
    inputRows,
    ({ entry }) => entry.request.sourceFile?.lexicalPath ?? null,
  );
  const local = reachableNativeSources(
    [
      ...input.roots.map(({ source }) => source),
      ...input.projectReferenceMembers,
      ...(edges.get(null) ?? []).map(({ include }) => include!),
    ],
    (source) => (edges.get(source) ?? []).map(({ include }) => include!),
  );

  return rows.every(({ entry, module, path, include, load }) => {
    if (
      (path !== undefined && include !== undefined && include !== load) ||
      module?.sourceLoadGap !== undefined ||
      path?.sourceLoadGap !== undefined
    )
      return false;
    const source = entry.request.sourceFile?.lexicalPath;
    const classified = module ?? path;
    return (
      source === undefined ||
      classified === undefined ||
      local.has(source) !== classified.sourceIsExternal
    );
  });
}

function currentReferences(
  adapter: NativeObservationAdapter,
  entries: readonly NativeRequestResult[],
): ReadonlyMap<string, NativeReferenceObservation> {
  const references = new Map(adapter.references);
  for (const { resolution } of entries) {
    const paths = [
      resolution.target?.lexicalPath,
      resolution.pathSelection?.logicalTarget,
    ];
    for (const path of paths)
      if (path != null && !references.has(path))
        references.set(path, observeNativeReference(adapter.program, path, ts));
  }
  return references;
}

function projectObligations(
  adapter: NativeObservationAdapter,
  rows: readonly CurrentRow[],
  references: ReadonlyMap<string, NativeReferenceObservation>,
): NativeCompilationObligation[] | undefined {
  const { project, context } = adapter.options;
  const { frontier } = adapter;
  const common = { context, frontier, compiler: ts, options: project.options };
  const obligations: NativeCompilationObligation[] = [];
  const attempted = new Set(
    frontier.attempts.map(({ file }) => frontier.fileKey(file.lexicalPath)),
  );
  for (const { row, entry, attempt, load } of rows) {
    const { request, resolution } = entry;
    const target = resolution.target?.lexicalPath;
    if (target !== undefined && (attempt !== undefined || load === target))
      attempted.add(frontier.fileKey(target));
    if (row.module !== undefined) {
      const extension = row.module.targetExtension;
      if (target !== undefined && extension === undefined) return undefined;
      obligations.push(
        projectNativeModuleObligation({
          ...common,
          requestId: request.id,
          premises: row.module,
          target:
            target === undefined
              ? undefined
              : {
                  resolvedFileName: target,
                  extension: extension!,
                  isExternalLibraryImport: resolution.externalLibrary === true,
                },
          completed: resolution.state !== 'unavailable',
          reference: target === undefined ? undefined : references.get(target),
        }),
      );
    }
    if (row.path === undefined) continue;
    const selection = resolution.pathSelection;
    if (selection === undefined) return undefined;
    const logical = selection.logicalTarget;
    const redirect =
      logical === null
        ? undefined
        : observedDeclarationRedirect(references.get(logical));
    if (
      selection.state === 'selected' &&
      (logical === null || physicalTarget(logical, redirect) !== target)
    )
      return undefined;
    obligations.push(
      createNativePathObligation({
        ...row.path,
        ...common,
        requestId: request.id,
        receipt: { selection, target, redirect },
        references,
      }),
    );
  }

  return [
    ...obligations,
    ...remainingNativeObligations(
      rows.map(({ entry }) => entry),
      obligations,
      project.options,
      frontier,
      (file) => attempted.has(file),
    ),
  ];
}

function composeEvidence(
  input: Composition,
  current: readonly CurrentRow[],
  obligations: readonly NativeCompilationObligation[],
): NativeEvidenceSnapshot {
  const { adapter } = input;
  const { context, project } = adapter.options;
  const { frontier } = adapter;
  const entries = current.map(({ entry }) => entry);
  const coverage = observedCoverage(frontier, entries);
  for (const file of [
    ...project.fileNames,
    ...input.members.map((member) => member.file),
  ])
    coverage.set(file, frontier.inspect(file).coverage);
  const partitions = current.map(({ entry, attempt, row }) => {
    const partition = nativeRequestPartition(entry, attempt);
    return partition.state === 'observed' &&
      row.entry.request.consumerContextId !== context.id
      ? { ...partition, state: 'restored' as const }
      : partition;
  });
  return freezeNativeData(
    assembleNativeSnapshot({
      context,
      frontier,
      coverage: coverage.values().toArray(),
      entries,
      projectReferences: adapter.program.getProjectReferences() ?? [],
      roots: project.fileNames,
      completeness: [...input.partitions, ...partitions],
      failures: [],
      obligations,
    }),
  );
}

function composedInventory(
  input: Composition,
  current: readonly CurrentRow[],
  records: readonly NativeRequestRecord[],
  syntax: ReadonlyMap<string, FileDependencyFacts>,
): NativeContextInventory {
  return freezeNativeData({
    modules: current.flatMap(({ row, entry }) =>
      row.module === undefined
        ? []
        : [{ ...row.module, requestId: entry.request.id }],
    ),
    paths: current.flatMap(({ row, entry }) =>
      row.path === undefined
        ? []
        : [{ ...row.path, requestId: entry.request.id }],
    ),
    inclusions: {
      requests: current.flatMap(({ entry, include }) =>
        include === undefined
          ? []
          : [{ requestId: entry.request.id, source: include }],
      ),
      projectReferences: input.projectReferenceMembers,
    },
    members: input.members.map(({ file }) => file),
    syntax: [...syntax].map(([file, facts]) => ({
      file,
      fingerprint: nativeFingerprint(facts),
    })),
    occurrences: records.map(({ request, record }) => ({
      requestId: request.id,
      fingerprint: nativeFingerprint([request, record]),
    })),
    loads: current.flatMap(({ entry, load }) =>
      load === undefined || entry.resolution.target === null
        ? []
        : [
            {
              requestId: entry.request.id,
              target: entry.resolution.target.lexicalPath,
              source: load,
            },
          ],
    ),
    roots: input.roots,
  });
}
