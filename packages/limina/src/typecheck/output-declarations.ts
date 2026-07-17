import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rmdir, unlink } from 'node:fs/promises';
import path from 'pathe';

import {
  createExplicitMutationAuthority,
  type MutationAuthority,
  type MutationBoundaryTarget,
  preflightMutationBoundary,
} from '#utils/mutation-boundary';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  toPosixPath,
  toRelativePath,
} from '#utils/path';

export interface OutputDeclarationCopyPlanEntry {
  authority?: MutationAuthority;
  outDir: string;
  rootDir: string;
  sourcePath: string;
  targetPath: string;
}

export type OutputDeclarationCopyProblemReason =
  | 'outside-root'
  | 'target-conflict'
  | 'target-is-out-dir'
  | 'target-outside-out-dir';

export interface OutputDeclarationCopyProblem {
  filePath: string;
  outDir: string;
  reason: OutputDeclarationCopyProblemReason;
  rootDir: string;
  severity: 'error' | 'warning';
  targetPath?: string;
}

export interface OutputDeclarationCopyPlan {
  entries: OutputDeclarationCopyPlanEntry[];
  problems: OutputDeclarationCopyProblem[];
}

export class OutputDeclarationCopyError extends Error {
  readonly problems: OutputDeclarationCopyProblem[];

  constructor(message: string, problems: OutputDeclarationCopyProblem[]) {
    super(message);
    this.name = 'OutputDeclarationCopyError';
    this.problems = problems;
  }
}

export function isDeclarationInputFile(fileName: string): boolean {
  return (
    fileName.endsWith('.d.ts') ||
    fileName.endsWith('.d.cts') ||
    fileName.endsWith('.d.mts')
  );
}

function isInNodeModules(filePath: string): boolean {
  return toPosixPath(normalizeAbsolutePath(filePath))
    .split('/')
    .includes('node_modules');
}

function problemKey(problem: OutputDeclarationCopyProblem): string {
  return [
    problem.severity,
    problem.reason,
    problem.filePath,
    problem.rootDir,
    problem.outDir,
    problem.targetPath ?? '',
  ].join('\0');
}

function entryKey(entry: OutputDeclarationCopyPlanEntry): string {
  return `${entry.sourcePath}\0${entry.targetPath}`;
}

export function createOutputDeclarationCopyPlan(options: {
  authority?: MutationAuthority;
  fileNames: string[];
  outDir: string;
  projectRootDir: string;
  rootDir: string;
}): OutputDeclarationCopyPlan {
  const rootDir = normalizeAbsolutePath(options.rootDir);
  const outDir = normalizeAbsolutePath(options.outDir);
  const entries = new Map<string, OutputDeclarationCopyPlanEntry>();
  const problems = new Map<string, OutputDeclarationCopyProblem>();

  for (const fileName of options.fileNames) {
    if (!isDeclarationInputFile(fileName)) {
      continue;
    }

    const sourcePath = normalizeAbsolutePath(fileName);

    if (isInNodeModules(sourcePath)) {
      continue;
    }

    if (isPathInsideDirectory(sourcePath, outDir)) {
      continue;
    }

    if (!isPathInsideDirectory(sourcePath, rootDir)) {
      const problem: OutputDeclarationCopyProblem = {
        filePath: sourcePath,
        outDir,
        reason: 'outside-root',
        rootDir,
        severity: 'warning',
      };

      problems.set(problemKey(problem), problem);
      continue;
    }

    const targetPath = normalizeAbsolutePath(
      path.join(outDir, path.relative(rootDir, sourcePath)),
    );

    if (targetPath === outDir) {
      const problem: OutputDeclarationCopyProblem = {
        filePath: sourcePath,
        outDir,
        reason: 'target-is-out-dir',
        rootDir,
        severity: 'error',
        targetPath,
      };

      problems.set(problemKey(problem), problem);
      continue;
    }

    if (!isPathInsideDirectory(targetPath, outDir)) {
      const problem: OutputDeclarationCopyProblem = {
        filePath: sourcePath,
        outDir,
        reason: 'target-outside-out-dir',
        rootDir,
        severity: 'error',
        targetPath,
      };

      problems.set(problemKey(problem), problem);
      continue;
    }

    const entry = {
      ...(options.authority ? { authority: options.authority } : {}),
      outDir,
      rootDir,
      sourcePath,
      targetPath,
    };

    entries.set(entryKey(entry), entry);
  }

  return {
    entries: [...entries.values()].sort((left, right) =>
      left.targetPath.localeCompare(right.targetPath),
    ),
    problems: [...problems.values()].sort(
      (left, right) =>
        left.severity.localeCompare(right.severity) ||
        left.filePath.localeCompare(right.filePath) ||
        (left.targetPath ?? '').localeCompare(right.targetPath ?? ''),
    ),
  };
}

export function mergeOutputDeclarationCopyPlans(
  plans: readonly OutputDeclarationCopyPlan[],
): OutputDeclarationCopyPlan {
  const entries = new Map<string, OutputDeclarationCopyPlanEntry>();
  const problems = new Map<string, OutputDeclarationCopyProblem>();

  for (const plan of plans) {
    for (const entry of plan.entries) {
      entries.set(entryKey(entry), entry);
    }

    for (const problem of plan.problems) {
      problems.set(problemKey(problem), problem);
    }
  }

  return {
    entries: [...entries.values()].sort((left, right) =>
      left.targetPath.localeCompare(right.targetPath),
    ),
    problems: [...problems.values()].sort(
      (left, right) =>
        left.severity.localeCompare(right.severity) ||
        left.filePath.localeCompare(right.filePath) ||
        (left.targetPath ?? '').localeCompare(right.targetPath ?? ''),
    ),
  };
}

function formatProblemPath(projectRootDir: string, filePath: string): string {
  return toRelativePath(projectRootDir, filePath);
}

function formatWarningProblem(options: {
  problem: OutputDeclarationCopyProblem;
  projectRootDir: string;
}): string[] {
  return [
    `  file: ${formatProblemPath(options.projectRootDir, options.problem.filePath)}`,
    `  rootDir: ${formatProblemPath(options.projectRootDir, options.problem.rootDir)}`,
    `  outDir: ${formatProblemPath(options.projectRootDir, options.problem.outDir)}`,
    '  reason: TypeScript uses this declaration input during build, but Limina only copies declaration inputs under output rootDir.',
    '  fix: move the declaration under rootDir, widen liminaOptions.outputs.rootDir, or add an explicit copy step.',
  ];
}

function assertNeverProblemReason(reason: never): never {
  throw new Error(
    `Unsupported output declaration copy problem reason: ${reason}`,
  );
}

function formatErrorProblem(options: {
  problem: OutputDeclarationCopyProblem;
  projectRootDir: string;
}): string[] {
  switch (options.problem.reason) {
    case 'target-conflict': {
      return [
        'Output declaration copy conflict:',
        `  source: ${formatProblemPath(options.projectRootDir, options.problem.filePath)}`,
        `  target: ${formatProblemPath(options.projectRootDir, options.problem.targetPath ?? options.problem.outDir)}`,
        '  reason: target already exists with different content.',
        '  fix: rename the declaration input, remove the conflicting emitted file, or exclude the declaration input.',
      ];
    }
    case 'target-is-out-dir': {
      return [
        'Output declaration copy target is invalid:',
        `  source: ${formatProblemPath(options.projectRootDir, options.problem.filePath)}`,
        `  target: ${formatProblemPath(options.projectRootDir, options.problem.targetPath ?? options.problem.outDir)}`,
        '  reason: declaration input maps to the output directory itself.',
        '  fix: move the declaration under a file path inside rootDir or adjust liminaOptions.outputs.',
      ];
    }
    case 'target-outside-out-dir': {
      return [
        'Output declaration copy target escapes outDir:',
        `  source: ${formatProblemPath(options.projectRootDir, options.problem.filePath)}`,
        `  target: ${formatProblemPath(options.projectRootDir, options.problem.targetPath ?? options.problem.outDir)}`,
        `  outDir: ${formatProblemPath(options.projectRootDir, options.problem.outDir)}`,
        '  reason: declaration input target path is outside output outDir.',
        '  fix: adjust liminaOptions.outputs.rootDir and outDir so copied declaration inputs stay inside outDir.',
      ];
    }
    case 'outside-root': {
      return [
        'Output declaration input is outside rootDir:',
        ...formatWarningProblem(options),
      ];
    }
    default: {
      return assertNeverProblemReason(options.problem.reason);
    }
  }
}

export function formatOutputDeclarationCopyWarnings(options: {
  problems: readonly OutputDeclarationCopyProblem[];
  projectRootDir: string;
}): string | null {
  const warningProblems = options.problems.filter(
    (problem) => problem.severity === 'warning',
  );

  if (warningProblems.length === 0) {
    return null;
  }

  return [
    'Output declaration inputs outside rootDir were not copied:',
    ...warningProblems.flatMap((problem, index) => [
      ...(index === 0 ? [] : ['']),
      ...formatWarningProblem({
        problem,
        projectRootDir: options.projectRootDir,
      }),
    ]),
  ].join('\n');
}

export function formatOutputDeclarationCopyErrors(options: {
  problems: readonly OutputDeclarationCopyProblem[];
  projectRootDir: string;
}): string | null {
  const errorProblems = options.problems.filter(
    (problem) => problem.severity === 'error',
  );

  if (errorProblems.length === 0) {
    return null;
  }

  return errorProblems
    .flatMap((problem, index) => [
      ...(index === 0 ? [] : ['']),
      ...formatErrorProblem({
        problem,
        projectRootDir: options.projectRootDir,
      }),
    ])
    .join('\n');
}

interface RegularFileState {
  readonly content: Buffer;
  readonly dev: string;
  readonly hash: string;
  readonly ino: string;
  readonly length: number;
  readonly mode: number;
  readonly nlink: number;
}

interface OwnedDeclarationFile {
  readonly authority: MutationAuthority;
  readonly path: string;
  readonly state: RegularFileState;
  readonly transactionToken: string;
}

interface OwnedDeclarationDirectory {
  readonly dev: string;
  readonly ino: string;
  readonly path: string;
  readonly transactionToken: string;
}

interface PreparedDeclarationEntry {
  readonly authority: MutationAuthority;
  readonly entry: OutputDeclarationCopyPlanEntry;
  readonly sourceState: RegularFileState;
  readonly targetState?: RegularFileState;
}

class ExclusivePublicationError extends Error {
  readonly cleanupErrors: Error[];
  readonly ownedFile?: OwnedDeclarationFile;

  constructor(options: {
    cause: unknown;
    cleanupErrors?: Error[];
    ownedFile?: OwnedDeclarationFile;
  }) {
    const cause =
      options.cause instanceof Error
        ? options.cause
        : new Error(String(options.cause));
    super(cause.message, { cause });
    this.name = 'ExclusivePublicationError';
    this.cleanupErrors = options.cleanupErrors ?? [];
    this.ownedFile = options.ownedFile;
  }
}

function isMissingError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && String(error.code) === 'ENOENT'
  );
}

function fileIdentityKey(state: RegularFileState): string {
  return JSON.stringify({
    dev: state.dev,
    hash: state.hash,
    ino: state.ino,
    length: state.length,
    mode: state.mode,
    nlink: state.nlink,
  });
}

async function readRegularFileState(
  filePath: string,
): Promise<RegularFileState> {
  const pathStats = await lstat(filePath);
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
    throw new Error(`Declaration path is not an ordinary file: ${filePath}.`);
  }
  const handle = await open(filePath, 'r');
  try {
    const before = await handle.stat();
    const content = await handle.readFile();
    const after = await handle.stat();
    const stable =
      String(pathStats.dev) === String(before.dev) &&
      String(pathStats.ino) === String(before.ino) &&
      String(before.dev) === String(after.dev) &&
      String(before.ino) === String(after.ino) &&
      Number(before.nlink) === Number(after.nlink) &&
      Number(before.size) === Number(after.size);
    if (!stable) {
      throw new Error(
        `Declaration file identity drifted while it was read: ${filePath}.`,
      );
    }
    return {
      content,
      dev: String(before.dev),
      hash: createHash('sha256').update(content).digest('hex'),
      ino: String(before.ino),
      length: content.byteLength,
      mode: Number(before.mode) & 0o7777,
      nlink: Number(before.nlink),
    };
  } finally {
    await handle.close();
  }
}

async function readRegularFileStateIfPresent(
  filePath: string,
): Promise<RegularFileState | undefined> {
  try {
    return await readRegularFileState(filePath);
  } catch (error) {
    if (isMissingError(error)) return undefined;
    throw error;
  }
}

async function readHandleState(
  handle: Awaited<ReturnType<typeof open>>,
): Promise<RegularFileState> {
  const before = await handle.stat();
  if (!before.isFile()) {
    throw new Error('Transaction-owned declaration target is not a file.');
  }
  const size = Number(before.size);
  const content = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(content, offset, size - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  const actualContent = content.subarray(0, offset);
  const after = await handle.stat();
  if (
    String(before.dev) !== String(after.dev) ||
    String(before.ino) !== String(after.ino) ||
    Number(before.nlink) !== Number(after.nlink) ||
    Number(before.size) !== Number(after.size)
  ) {
    throw new Error(
      'Transaction-owned declaration identity drifted while it was verified.',
    );
  }
  return {
    content: actualContent,
    dev: String(after.dev),
    hash: createHash('sha256').update(actualContent).digest('hex'),
    ino: String(after.ino),
    length: actualContent.byteLength,
    mode: Number(after.mode) & 0o7777,
    nlink: Number(after.nlink),
  };
}

async function resolveEntryAuthority(options: {
  entry: OutputDeclarationCopyPlanEntry;
  projectRootDir: string;
  requireAuthenticatedAuthorities: boolean;
}): Promise<MutationAuthority> {
  if (options.entry.authority) return options.entry.authority;
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

async function prepareDeclarationEntries(options: {
  entries: readonly OutputDeclarationCopyPlanEntry[];
  projectRootDir: string;
  requireAuthenticatedAuthorities: boolean;
}): Promise<{
  boundaryTargets: MutationBoundaryTarget[];
  entries: PreparedDeclarationEntry[];
  problems: OutputDeclarationCopyProblem[];
}> {
  const preparedByTarget = new Map<string, PreparedDeclarationEntry>();
  const problems: OutputDeclarationCopyProblem[] = [];
  const boundaryTargets: MutationBoundaryTarget[] = [];

  for (const entry of options.entries) {
    const authority = await resolveEntryAuthority({
      entry,
      projectRootDir: options.projectRootDir,
      requireAuthenticatedAuthorities: options.requireAuthenticatedAuthorities,
    });
    boundaryTargets.push(
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
    const sourceState = await readRegularFileState(entry.sourcePath);
    const duplicate = preparedByTarget.get(entry.targetPath);
    if (duplicate) {
      if (!sourceState.content.equals(duplicate.sourceState.content)) {
        problems.push(createConflictProblem(entry));
      }
      continue;
    }
    const targetState = await readRegularFileStateIfPresent(entry.targetPath);
    if (targetState && !sourceState.content.equals(targetState.content)) {
      problems.push(createConflictProblem(entry));
    }
    preparedByTarget.set(entry.targetPath, {
      authority,
      entry,
      sourceState,
      ...(targetState ? { targetState } : {}),
    });
  }

  return {
    boundaryTargets,
    entries: [...preparedByTarget.values()].sort((left, right) =>
      left.entry.targetPath.localeCompare(right.entry.targetPath),
    ),
    problems,
  };
}

async function assertPreparedEntriesCurrent(
  entries: readonly PreparedDeclarationEntry[],
): Promise<void> {
  for (const prepared of entries) {
    const currentSource = await readRegularFileState(prepared.entry.sourcePath);
    if (
      fileIdentityKey(currentSource) !== fileIdentityKey(prepared.sourceState)
    ) {
      throw new Error(
        `Declaration source drifted after transaction preflight: ${prepared.entry.sourcePath}.`,
      );
    }
    const currentTarget = await readRegularFileStateIfPresent(
      prepared.entry.targetPath,
    );
    if (prepared.targetState) {
      if (
        !currentTarget ||
        fileIdentityKey(currentTarget) !== fileIdentityKey(prepared.targetState)
      ) {
        throw new Error(
          `Identical declaration target drifted after preflight: ${prepared.entry.targetPath}.`,
        );
      }
    } else if (currentTarget) {
      throw new Error(
        `Missing declaration target appeared after preflight: ${prepared.entry.targetPath}.`,
      );
    }
  }
}

async function ensureDeclarationParentDirectories(options: {
  prepared: PreparedDeclarationEntry;
  transactionToken: string;
}): Promise<OwnedDeclarationDirectory[]> {
  const owned: OwnedDeclarationDirectory[] = [];
  const parentPath = path.dirname(options.prepared.entry.targetPath);
  const relative = path.relative(
    options.prepared.authority.trustedBaseLogicalPath,
    parentPath,
  );
  let cursor = options.prepared.authority.trustedBaseLogicalPath;

  for (const segment of relative === '' ? [] : relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    try {
      const stats = await lstat(cursor);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(
          `Declaration output parent is not an ordinary directory: ${cursor}.`,
        );
      }
      continue;
    } catch (error) {
      if (!isMissingError(error)) throw error;
    }

    await preflightMutationBoundary([
      {
        authority: options.prepared.authority,
        kind: 'file',
        path: options.prepared.entry.targetPath,
      },
    ]);
    try {
      await mkdir(cursor);
      const stats = await lstat(cursor);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(
          `Transaction-created declaration parent is unsafe: ${cursor}.`,
        );
      }
      owned.push({
        dev: String(stats.dev),
        ino: String(stats.ino),
        path: cursor,
        transactionToken: options.transactionToken,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        String(error.code) === 'EEXIST'
      ) {
        const stats = await lstat(cursor);
        if (!stats.isDirectory() || stats.isSymbolicLink()) throw error;
        continue;
      }
      throw error;
    }
  }
  return owned;
}

async function publishDeclarationExclusive(options: {
  prepared: PreparedDeclarationEntry;
  transactionToken: string;
}): Promise<OwnedDeclarationFile> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let ownedFile: OwnedDeclarationFile | undefined;
  const cleanupErrors: Error[] = [];
  let primaryError: unknown;

  try {
    handle = await open(options.prepared.entry.targetPath, 'wx+');
    try {
      await handle.writeFile(options.prepared.sourceState.content);
      await handle.sync();
    } catch (error) {
      primaryError = error;
    }
    try {
      const state = await readHandleState(handle);
      ownedFile = {
        authority: options.prepared.authority,
        path: options.prepared.entry.targetPath,
        state,
        transactionToken: options.transactionToken,
      };
      if (
        !primaryError &&
        !state.content.equals(options.prepared.sourceState.content)
      ) {
        primaryError = new Error(
          `Exclusive declaration publication content verification failed: ${options.prepared.entry.targetPath}.`,
        );
      }
    } catch (error) {
      if (primaryError) {
        cleanupErrors.push(
          error instanceof Error ? error : new Error(String(error)),
        );
      } else {
        primaryError = error;
      }
    }
  } catch (error) {
    primaryError = error;
  }

  if (handle) {
    try {
      await handle.close();
    } catch (error) {
      const closeError =
        error instanceof Error ? error : new Error(String(error));
      if (primaryError) cleanupErrors.push(closeError);
      else primaryError = closeError;
    }
  }
  if (primaryError) {
    throw new ExclusivePublicationError({
      cause: primaryError,
      cleanupErrors,
      ...(ownedFile ? { ownedFile } : {}),
    });
  }
  if (!ownedFile) {
    throw new ExclusivePublicationError({
      cause: new Error(
        `Unable to capture transaction-owned declaration identity: ${options.prepared.entry.targetPath}.`,
      ),
    });
  }
  return ownedFile;
}

async function rollbackOwnedFile(owned: OwnedDeclarationFile): Promise<void> {
  await preflightMutationBoundary([
    {
      authority: owned.authority,
      kind: 'file',
      path: owned.path,
    },
  ]);
  const current = await readRegularFileStateIfPresent(owned.path);
  if (!current || fileIdentityKey(current) !== fileIdentityKey(owned.state)) {
    throw new Error(
      `Refusing to delete a declaration target whose transaction identity drifted: ${owned.path}.`,
    );
  }
  await unlink(owned.path);
}

async function rollbackOwnedDirectory(
  owned: OwnedDeclarationDirectory,
): Promise<void> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(owned.path);
  } catch (error) {
    if (isMissingError(error)) {
      throw new Error(
        `Transaction-created declaration directory disappeared before cleanup: ${owned.path}.`,
      );
    }
    throw error;
  }
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    String(stats.dev) !== owned.dev ||
    String(stats.ino) !== owned.ino
  ) {
    throw new Error(
      `Refusing to remove a declaration directory whose transaction identity drifted: ${owned.path}.`,
    );
  }
  await rmdir(owned.path);
}

function throwWithCleanupErrors(
  primaryError: unknown,
  cleanupErrors: readonly Error[],
): never {
  const primary =
    primaryError instanceof Error
      ? primaryError
      : new Error(String(primaryError));
  if (cleanupErrors.length === 0) throw primary;
  throw new AggregateError(
    [primary, ...cleanupErrors],
    `${primary.message}\nDeclaration rollback/cleanup also failed:\n${cleanupErrors
      .map((error) => `  - ${error.message}`)
      .join('\n')}`,
    { cause: primary },
  );
}

export async function copyOutputDeclarationInputs(
  plan: OutputDeclarationCopyPlan,
  options: {
    /** Transaction-race injection used only by focused source-level tests. */
    beforePublishForTesting?: (
      entry: Readonly<OutputDeclarationCopyPlanEntry>,
      index: number,
    ) => Promise<void> | void;
    projectRootDir: string;
    requireAuthenticatedAuthorities?: boolean;
  },
): Promise<void> {
  const plannedError = formatOutputDeclarationCopyErrors({
    problems: plan.problems,
    projectRootDir: options.projectRootDir,
  });

  if (plannedError) {
    throw new OutputDeclarationCopyError(
      plannedError,
      plan.problems.filter((problem) => problem.severity === 'error'),
    );
  }

  const prepared = await prepareDeclarationEntries({
    entries: plan.entries,
    projectRootDir: options.projectRootDir,
    requireAuthenticatedAuthorities:
      options.requireAuthenticatedAuthorities ?? false,
  });
  await preflightMutationBoundary(prepared.boundaryTargets);
  if (prepared.problems.length > 0) {
    throw new OutputDeclarationCopyError(
      formatOutputDeclarationCopyErrors({
        problems: prepared.problems,
        projectRootDir: options.projectRootDir,
      }) ?? '',
      prepared.problems,
    );
  }
  await assertPreparedEntriesCurrent(prepared.entries);

  const transactionToken = randomUUID();
  const ownedFiles: OwnedDeclarationFile[] = [];
  const ownedDirectories: OwnedDeclarationDirectory[] = [];
  try {
    for (const entry of prepared.entries.filter(
      (candidate) => !candidate.targetState,
    )) {
      ownedDirectories.push(
        ...(await ensureDeclarationParentDirectories({
          prepared: entry,
          transactionToken,
        })),
      );
    }
    await assertPreparedEntriesCurrent(prepared.entries);
    const missingEntries = prepared.entries.filter(
      (candidate) => !candidate.targetState,
    );
    for (const [index, entry] of missingEntries.entries()) {
      try {
        await options.beforePublishForTesting?.(entry.entry, index);
        ownedFiles.push(
          await publishDeclarationExclusive({
            prepared: entry,
            transactionToken,
          }),
        );
      } catch (error) {
        if (error instanceof ExclusivePublicationError && error.ownedFile) {
          ownedFiles.push(error.ownedFile);
        }
        throw error;
      }
    }
  } catch (error) {
    const cleanupErrors: Error[] =
      error instanceof ExclusivePublicationError
        ? [...error.cleanupErrors]
        : [];
    for (const owned of ownedFiles.toReversed()) {
      try {
        await rollbackOwnedFile(owned);
      } catch (cleanupError) {
        cleanupErrors.push(
          cleanupError instanceof Error
            ? cleanupError
            : new Error(String(cleanupError)),
        );
      }
    }
    for (const owned of ownedDirectories.toReversed()) {
      try {
        await rollbackOwnedDirectory(owned);
      } catch (cleanupError) {
        cleanupErrors.push(
          cleanupError instanceof Error
            ? cleanupError
            : new Error(String(cleanupError)),
        );
      }
    }
    throwWithCleanupErrors(error, cleanupErrors);
  }
}
