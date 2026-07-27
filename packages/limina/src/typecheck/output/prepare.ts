import {
  createExplicitMutationAuthority,
  type MutationAuthority,
  type MutationBoundaryTarget,
} from '#utils/mutation-boundary';
import {
  fileIdentityKey,
  readRegularFileState,
  readRegularFileStateIfPresent,
} from './state';
import type {
  OutputDeclarationCopyPlanEntry,
  OutputDeclarationCopyProblem,
  PreparedDeclarationCollection,
  PreparedDeclarationEntry,
  RegularFileState,
} from './types';

interface PrepareState {
  boundaryTargets: MutationBoundaryTarget[];
  preparedByTarget: Map<string, PreparedDeclarationEntry>;
  problems: OutputDeclarationCopyProblem[];
}

async function resolveEntryAuthority(options: {
  entry: OutputDeclarationCopyPlanEntry;
  projectRootDir: string;
  requireAuthenticatedAuthorities: boolean;
}): Promise<MutationAuthority> {
  if (options.entry.authority !== undefined) return options.entry.authority;
  if (options.requireAuthenticatedAuthorities) {
    throw new Error(
      `Missing validated declaration output authority for ${options.entry.outDir}.`,
    );
  }
  return createExplicitMutationAuthority({
    logicalMutationRoot: options.entry.outDir,
    scope: 'directory',
    trustedBasePath: options.projectRootDir,
  });
}

function createConflictProblem(
  entry: OutputDeclarationCopyPlanEntry,
): OutputDeclarationCopyProblem {
  return {
    filePath: entry.sourcePath,
    outDir: entry.outDir,
    reason: 'target-conflict',
    rootDir: entry.rootDir,
    severity: 'error',
    targetPath: entry.targetPath,
  };
}

function addBoundaryTargets(
  state: PrepareState,
  entry: OutputDeclarationCopyPlanEntry,
  authority: MutationAuthority,
): void {
  state.boundaryTargets.push(
    {
      authority,
      kind: 'directory',
      path: entry.outDir,
      recursive: true,
    },
    {
      authority,
      kind: 'file',
      path: entry.targetPath,
    },
  );
}

function hasContentConflict(
  sourceState: RegularFileState,
  targetState: RegularFileState,
): boolean {
  return !sourceState.content.equals(targetState.content);
}

function createPreparedEntry(options: {
  authority: MutationAuthority;
  entry: OutputDeclarationCopyPlanEntry;
  sourceState: RegularFileState;
  targetState: RegularFileState | undefined;
}): PreparedDeclarationEntry {
  if (options.targetState === undefined) {
    return {
      authority: options.authority,
      entry: options.entry,
      sourceState: options.sourceState,
    };
  }
  return {
    authority: options.authority,
    entry: options.entry,
    sourceState: options.sourceState,
    targetState: options.targetState,
  };
}

function handleDuplicate(options: {
  duplicate: PreparedDeclarationEntry;
  entry: OutputDeclarationCopyPlanEntry;
  sourceState: RegularFileState;
  state: PrepareState;
}): void {
  if (hasContentConflict(options.sourceState, options.duplicate.sourceState)) {
    options.state.problems.push(createConflictProblem(options.entry));
  }
}

function addTargetConflictIfNeeded(options: {
  entry: OutputDeclarationCopyPlanEntry;
  sourceState: RegularFileState;
  state: PrepareState;
  targetState: RegularFileState | undefined;
}): void {
  if (options.targetState === undefined) return;
  if (!hasContentConflict(options.sourceState, options.targetState)) return;
  options.state.problems.push(createConflictProblem(options.entry));
}

async function prepareEntry(options: {
  entry: OutputDeclarationCopyPlanEntry;
  projectRootDir: string;
  requireAuthenticatedAuthorities: boolean;
  state: PrepareState;
}): Promise<void> {
  const authority = await resolveEntryAuthority(options);
  addBoundaryTargets(options.state, options.entry, authority);
  const sourceState = await readRegularFileState(options.entry.sourcePath);
  const duplicate = options.state.preparedByTarget.get(
    options.entry.targetPath,
  );
  if (duplicate !== undefined) {
    handleDuplicate({
      duplicate,
      entry: options.entry,
      sourceState,
      state: options.state,
    });
    return;
  }
  const targetState = await readRegularFileStateIfPresent(
    options.entry.targetPath,
  );
  addTargetConflictIfNeeded({
    entry: options.entry,
    sourceState,
    state: options.state,
    targetState,
  });
  options.state.preparedByTarget.set(
    options.entry.targetPath,
    createPreparedEntry({
      authority,
      entry: options.entry,
      sourceState,
      targetState,
    }),
  );
}

function comparePreparedEntries(
  left: PreparedDeclarationEntry,
  right: PreparedDeclarationEntry,
): number {
  return left.entry.targetPath.localeCompare(right.entry.targetPath);
}

export async function prepareDeclarationEntries(options: {
  entries: readonly OutputDeclarationCopyPlanEntry[];
  projectRootDir: string;
  requireAuthenticatedAuthorities: boolean;
}): Promise<PreparedDeclarationCollection> {
  const state: PrepareState = {
    boundaryTargets: [],
    preparedByTarget: new Map(),
    problems: [],
  };
  for (const entry of options.entries) {
    await prepareEntry({ ...options, entry, state });
  }
  return {
    boundaryTargets: state.boundaryTargets,
    entries: [...state.preparedByTarget.values()].sort(comparePreparedEntries),
    problems: state.problems,
  };
}

function assertSameIdentity(options: {
  current: RegularFileState;
  expected: RegularFileState;
  message: string;
}): void {
  if (fileIdentityKey(options.current) !== fileIdentityKey(options.expected)) {
    throw new Error(options.message);
  }
}

function assertUnexpectedTargetAbsent(
  currentTarget: RegularFileState | undefined,
  prepared: PreparedDeclarationEntry,
): void {
  if (currentTarget === undefined) return;
  throw new Error(
    `Missing declaration target appeared after preflight: ${prepared.entry.targetPath}.`,
  );
}

function assertExpectedTargetCurrent(options: {
  currentTarget: RegularFileState | undefined;
  expectedTarget: RegularFileState;
  prepared: PreparedDeclarationEntry;
}): void {
  if (options.currentTarget === undefined) {
    throw new Error(
      `Identical declaration target drifted after preflight: ${options.prepared.entry.targetPath}.`,
    );
  }
  assertSameIdentity({
    current: options.currentTarget,
    expected: options.expectedTarget,
    message: `Identical declaration target drifted after preflight: ${options.prepared.entry.targetPath}.`,
  });
}

function assertPreparedTargetCurrent(options: {
  currentTarget: RegularFileState | undefined;
  prepared: PreparedDeclarationEntry;
}): void {
  const expectedTarget = options.prepared.targetState;
  if (expectedTarget === undefined) {
    assertUnexpectedTargetAbsent(options.currentTarget, options.prepared);
    return;
  }
  assertExpectedTargetCurrent({ ...options, expectedTarget });
}

async function assertPreparedEntryCurrent(
  prepared: PreparedDeclarationEntry,
): Promise<void> {
  const currentSource = await readRegularFileState(prepared.entry.sourcePath);
  assertSameIdentity({
    current: currentSource,
    expected: prepared.sourceState,
    message: `Declaration source drifted after transaction preflight: ${prepared.entry.sourcePath}.`,
  });
  assertPreparedTargetCurrent({
    currentTarget: await readRegularFileStateIfPresent(
      prepared.entry.targetPath,
    ),
    prepared,
  });
}

export async function assertPreparedEntriesCurrent(
  entries: readonly PreparedDeclarationEntry[],
): Promise<void> {
  for (const prepared of entries) {
    await assertPreparedEntryCurrent(prepared);
  }
}
