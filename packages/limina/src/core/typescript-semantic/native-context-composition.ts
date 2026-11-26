import ts from 'typescript';
import type { NativeEvidenceContext } from '../../domain/analysis/native-context';
import type { NativeFileIdentity } from '../../domain/analysis/native-coverage';
import type {
  NativeCompletenessPartition,
  NativeEvidenceSnapshot,
} from '../../domain/analysis/native-evidence';
import type { TypeScriptSemanticDependencyContext } from './contracts';
import type { FileDependencyFacts } from './file-dependency-facts';
import {
  type ComposedNativeMember,
  type NativeObservationRow,
  projectComposedNativeContext,
} from './native-composed-evidence';
import type { NativeContextInventory } from './native-context-inventory';
import type { NativeDependencyContext } from './native-dependency-context';
import {
  hasSameNativeFileBinding,
  nativeFingerprint,
} from './native-file-identity';
import { nativeLibraryFileName } from './native-library-api';
import type { NativeObservationAdapter } from './native-observation-adapter';

interface Composition {
  adapter: NativeObservationAdapter;
  observed: NativeDependencyContext;
  previous: TypeScriptSemanticDependencyContext;
  reusableFiles: ReadonlySet<string>;
  readPreviousSyntax?(file: string): FileDependencyFacts | undefined;
}

interface Slice {
  context: TypeScriptSemanticDependencyContext;
  environment: NativeObservationRow[];
  sources: Map<string, NativeObservationRow[]>;
  roots: Map<string, string>;
  partitions: Map<string, NativeCompletenessPartition>;
  projectReferenceMembers: readonly string[];
  bindings: Map<string, NativeFileIdentity>;
  syntaxWitnesses: Map<string, string>;
}

export function composeNativeContext(input: Composition):
  | {
      context: NativeDependencyContext;
      restoredFiles: ReadonlySet<string>;
      restoredLibraryNames: ReadonlySet<string>;
    }
  | undefined {
  const { adapter } = input;
  const previous = completeSlice(input.previous);
  const observed = completeSlice(input.observed);
  if (
    previous === undefined ||
    observed === undefined ||
    !hasMatchingCompilerInputs(
      input.previous.nativeEvidence!.contexts[0]!,
      adapter.options.context,
    )
  )
    return undefined;

  const roots = currentRoots(adapter, observed, previous, input.reusableFiles);
  if (roots === undefined) return undefined;
  const members = collectMembers(input, observed, previous, roots);
  if (members === undefined) return undefined;

  const restoredFiles = new Set(
    members.filter((member) => member.restored).map(({ file }) => file),
  );
  const libraries = restoredLibraries(members, observed, previous);
  const context = projectComposedNativeContext({
    adapter,
    roots: roots.loaded,
    partitions: roots.partitions,
    members,
    environment: [...observed.environment, ...libraries],
    projectReferenceMembers: observed.projectReferenceMembers,
  });
  return context === undefined
    ? undefined
    : {
        context,
        restoredFiles,
        restoredLibraryNames: new Set(
          libraries.map(({ entry }) => entry.request.specifier),
        ),
      };
}

function completeSlice(
  context: TypeScriptSemanticDependencyContext,
): Slice | undefined {
  const snapshot = context.nativeEvidence;
  const inventory = context.nativeInventory;
  const inclusions = inventory?.inclusions;
  if (
    inventory === undefined ||
    inclusions === undefined ||
    snapshot?.run !== 'completed' ||
    snapshot.failures.length > 0
  )
    return undefined;
  const partitions = new Map(
    snapshot.completeness.map((part) => [part.entryId, part]),
  );
  const rows = collectRows(context, snapshot, inventory, partitions);
  if (rows === undefined) return undefined;
  const sources = new Map(
    inventory.members.map((member) => [member, [] as NativeObservationRow[]]),
  );
  const environment: NativeObservationRow[] = [];
  for (const row of rows) {
    const file = row.entry.request.sourceFile?.lexicalPath;
    const destination = file === undefined ? environment : sources.get(file);
    if (destination === undefined) return undefined;
    destination.push(row);
  }
  return {
    context,
    environment,
    sources,
    roots: new Map(inventory.roots.map(({ root, source }) => [root, source])),
    partitions,
    projectReferenceMembers: inclusions.projectReferences,
    bindings: new Map(
      snapshot.coverage.map(({ target }) => [target.lexicalPath, target]),
    ),
    syntaxWitnesses: new Map(
      inventory.syntax.map(({ file, fingerprint }) => [file, fingerprint]),
    ),
  };
}

function collectRows(
  context: TypeScriptSemanticDependencyContext,
  snapshot: NativeEvidenceSnapshot,
  inventory: NativeContextInventory,
  partitions: Map<string, NativeCompletenessPartition>,
): NativeObservationRow[] | undefined {
  const modules = new Map(
    inventory.modules.map((item) => [item.requestId, item]),
  );
  const paths = new Map(inventory.paths.map((item) => [item.requestId, item]));
  const loads = new Map(
    inventory.loads.map((item) => [item.requestId, item.source]),
  );
  const includes = new Map(
    inventory.inclusions?.requests.map((item) => [item.requestId, item.source]),
  );
  const resolutions = new Map(
    snapshot.resolutions.map((item) => [item.requestId, item]),
  );
  const records = new Map(
    inventory.members.flatMap((file) =>
      context.getImportRecords(file).map((record) => {
        const { nativeEvidence, resolution } =
          context.getDependencyFact(record);
        return [
          nativeEvidence!.requestId,
          { record, origin: resolution.target?.resolutionOrigin },
        ] as const;
      }),
    ),
  );
  const rows: NativeObservationRow[] = [];
  for (const request of snapshot.requests) {
    const id = request.id;
    const resolution = resolutions.get(id);
    const partition = partitions.get(id);
    if (resolution === undefined || partition === undefined) return undefined;
    rows.push({
      entry: { request, resolution },
      partition,
      module: modules.get(id),
      path: paths.get(id),
      include: includes.get(id),
      load: loads.get(id),
      ...records.get(id),
    });
  }
  return rows;
}

function hasMatchingCompilerInputs(
  previous: NativeEvidenceContext,
  current: NativeEvidenceContext,
): boolean {
  const stableInputs: readonly (keyof NativeEvidenceContext['inputs'])[] = [
    'typescriptVersion',
    'typescriptImplementation',
    'toolchain',
    'hostContract',
    'config',
    'sourceConfig',
    'options',
    'rawReferences',
    'compilationScope',
  ];
  return (
    stableInputs.every((key) => previous.inputs[key] === current.inputs[key]) &&
    previous.authority.phase === current.authority.phase &&
    (previous.authority.phase === 'pending' ||
      (current.authority.phase === 'locked' &&
        previous.authority.family === current.authority.family))
  );
}

interface CurrentRoots {
  loaded: NativeContextInventory['roots'][number][];
  partitions: NativeCompletenessPartition[];
}

function currentRoots(
  adapter: NativeObservationAdapter,
  observed: Slice,
  previous: Slice,
  reusableFiles: ReadonlySet<string>,
): CurrentRoots | undefined {
  const { project, context } = adapter.options;
  const loaded: CurrentRoots['loaded'] = [];
  const partitions: CurrentRoots['partitions'] = [];
  const rootNames = new Set(project.fileNames);
  for (const root of rootNames) {
    const fresh = observed.partitions.get(root);
    if (fresh !== undefined) {
      const source = observed.roots.get(root);
      if (source !== undefined) loaded.push({ root, source });
      partitions.push(fresh);
      continue;
    }
    const source = previous.roots.get(root);
    const decision = adapter.frontier.inspect(root);
    if (
      source !== undefined &&
      reusableFiles.has(source) &&
      decision.decision.action === 'expand'
    ) {
      loaded.push({ root, source });
      partitions.push({
        contextId: context.id,
        entryId: root,
        channel: 'implicit',
        state: 'restored',
        evidenceIds: [root],
      });
      continue;
    }
    const stop = previous.partitions.get(root);
    if (
      stop?.state !== 'proven-stop' ||
      decision.file.physical.state !== 'verified' ||
      decision.decision.action !== 'stop' ||
      decision.decision.reason !== stop.stopReason
    )
      return undefined;
    partitions.push({
      contextId: context.id,
      entryId: root,
      channel: 'implicit',
      state: 'proven-stop',
      stopReason: decision.decision.reason,
      evidenceIds: [root],
    });
  }
  return { loaded, partitions };
}

function collectMembers(
  input: Composition,
  observed: Slice,
  previous: Slice,
  roots: CurrentRoots,
): ComposedNativeMember[] | undefined {
  const frontier = input.adapter.frontier;
  const work = [
    ...roots.loaded.map(({ source }) => source),
    ...observed.projectReferenceMembers,
    ...observed.environment.flatMap(({ include }) =>
      include === undefined ? [] : [include],
    ),
  ];
  const visited = new Set<string>();
  const actualRoots = new Set(observed.roots.values());
  const oldRoots = new Set(previous.roots.values());
  const rootSources = new Set(roots.loaded.map(({ source }) => source));
  const members: ComposedNativeMember[] = [];
  let cursor = 0;
  while (cursor < work.length) {
    const file = work[cursor++]!;
    if (visited.has(file)) continue;
    visited.add(file);
    const old = previous.sources.get(file);
    const fresh = observed.sources.get(file);
    const canRestore = old !== undefined && input.reusableFiles.has(file);
    // Under TS's node_modules depth rules, a project root incidentally loaded
    // by a shard may be external there while its standalone root is local.
    const hasRestoredSource =
      canRestore &&
      (fresh === undefined ||
        (rootSources.has(file) && !actualRoots.has(file)));
    if (hasRestoredSource && oldRoots.has(file) && !rootSources.has(file))
      return undefined;

    const rows = hasRestoredSource ? old : fresh;
    const target = frontier.inspect(file);
    if (
      rows === undefined ||
      target.file.physical.state !== 'verified' ||
      target.decision.action !== 'expand'
    )
      return undefined;
    if (hasRestoredSource) {
      const binding = previous.bindings.get(file);
      if (
        binding === undefined ||
        !hasSameNativeFileBinding(binding, target.file)
      )
        return undefined;
    }
    const donor = hasRestoredSource ? previous : observed;
    const syntax = hasRestoredSource
      ? input.readPreviousSyntax?.(file)
      : donor.context.getFileDependencyFacts?.(file);
    const witness = donor.syntaxWitnesses.get(file);
    if (
      witness !== undefined &&
      (syntax === undefined || nativeFingerprint(syntax) !== witness)
    )
      return undefined;
    members.push({ file, rows, syntax, restored: hasRestoredSource });
    for (const row of rows) {
      if (row.include === undefined) continue;
      const included = frontier.inspect(row.include);
      if (included.decision.action === 'expand') work.push(row.include);
    }
  }
  return members;
}

function restoredLibraries(
  members: readonly ComposedNativeMember[],
  observed: Slice,
  previous: Slice,
): NativeObservationRow[] {
  const observedNames = new Set(
    observed.environment
      .filter(isLibrary)
      .map(({ entry }) => entry.request.specifier),
  );
  const activeNames = new Set(
    members.flatMap(({ rows }) =>
      rows.flatMap((row) => {
        if (!isLibrary(row) || row.entry.resolution.target === null) return [];
        const name = nativeLibraryFileName(ts, {
          fileName: row.entry.request.specifier,
        });
        return name === undefined ? [] : [name];
      }),
    ),
  );
  return previous.environment.filter(
    (row) =>
      isLibrary(row) &&
      row.entry.resolution.target !== null &&
      row.include === undefined &&
      !observedNames.has(row.entry.request.specifier) &&
      activeNames.has(row.entry.request.specifier),
  );
}

function isLibrary(row: NativeObservationRow): boolean {
  return row.entry.request.channel === 'library';
}
