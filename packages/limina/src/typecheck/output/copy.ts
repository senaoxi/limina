import { preflightMutationBoundary } from '#utils/mutation-boundary';
import { randomUUID } from 'node:crypto';
import {
  ensureDeclarationParentDirectories,
  rollbackOwnedDirectory,
} from './directories';
import {
  assertPreparedEntriesCurrent,
  prepareDeclarationEntries,
} from './prepare';
import {
  ExclusivePublicationError,
  publishDeclarationExclusive,
  rollbackOwnedFile,
} from './publish';
import { formatOutputDeclarationCopyErrors } from './report';
import {
  OutputDeclarationCopyError,
  type OutputDeclarationCopyOptions,
  type OutputDeclarationCopyPlan,
  type OwnedDeclarationDirectory,
  type OwnedDeclarationFile,
  type PreparedDeclarationCollection,
  type PreparedDeclarationEntry,
} from './types';

interface PublicationState {
  ownedDirectories: OwnedDeclarationDirectory[];
  ownedFiles: OwnedDeclarationFile[];
  transactionToken: string;
}

function getErrorProblems(
  plan: OutputDeclarationCopyPlan,
): OutputDeclarationCopyPlan['problems'] {
  return plan.problems.filter((problem) => problem.severity === 'error');
}

function assertPlanHasNoErrors(
  plan: OutputDeclarationCopyPlan,
  projectRootDir: string,
): void {
  const message = formatOutputDeclarationCopyErrors({
    problems: plan.problems,
    projectRootDir,
  });
  if (message === null) return;
  throw new OutputDeclarationCopyError(message, getErrorProblems(plan));
}

function getAuthenticatedAuthorityRequirement(
  options: OutputDeclarationCopyOptions,
): boolean {
  return options.requireAuthenticatedAuthorities === true;
}

async function prepareValidatedCollection(
  plan: OutputDeclarationCopyPlan,
  options: OutputDeclarationCopyOptions,
): Promise<PreparedDeclarationCollection> {
  const prepared = await prepareDeclarationEntries({
    entries: plan.entries,
    projectRootDir: options.projectRootDir,
    requireAuthenticatedAuthorities:
      getAuthenticatedAuthorityRequirement(options),
  });
  await preflightMutationBoundary(prepared.boundaryTargets);
  if (prepared.problems.length === 0) return prepared;
  const message = formatOutputDeclarationCopyErrors({
    problems: prepared.problems,
    projectRootDir: options.projectRootDir,
  });
  throw new OutputDeclarationCopyError(
    message === null ? '' : message,
    prepared.problems,
  );
}

function getMissingEntries(
  entries: readonly PreparedDeclarationEntry[],
): PreparedDeclarationEntry[] {
  return entries.filter((entry) => entry.targetState === undefined);
}

async function createParentDirectories(
  entries: readonly PreparedDeclarationEntry[],
  state: PublicationState,
): Promise<void> {
  for (const prepared of entries) {
    const directories = await ensureDeclarationParentDirectories({
      prepared,
      transactionToken: state.transactionToken,
    });
    state.ownedDirectories.push(...directories);
  }
}

async function runBeforePublishHook(options: {
  copyOptions: OutputDeclarationCopyOptions;
  index: number;
  prepared: PreparedDeclarationEntry;
}): Promise<void> {
  const hook = options.copyOptions.beforePublishForTesting;
  if (hook === undefined) return;
  await hook(options.prepared.entry, options.index);
}

function captureFailedOwnedFile(error: unknown, state: PublicationState): void {
  if (!(error instanceof ExclusivePublicationError)) return;
  if (error.ownedFile === undefined) return;
  state.ownedFiles.push(error.ownedFile);
}

async function publishPreparedEntry(options: {
  copyOptions: OutputDeclarationCopyOptions;
  index: number;
  prepared: PreparedDeclarationEntry;
  state: PublicationState;
}): Promise<void> {
  await runBeforePublishHook(options);
  try {
    const owned = await publishDeclarationExclusive({
      prepared: options.prepared,
      transactionToken: options.state.transactionToken,
    });
    options.state.ownedFiles.push(owned);
  } catch (error) {
    captureFailedOwnedFile(error, options.state);
    throw error;
  }
}

async function publishMissingEntries(options: {
  copyOptions: OutputDeclarationCopyOptions;
  entries: readonly PreparedDeclarationEntry[];
  state: PublicationState;
}): Promise<void> {
  for (const [index, prepared] of options.entries.entries()) {
    await publishPreparedEntry({ ...options, index, prepared });
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function rollbackFiles(
  ownedFiles: readonly OwnedDeclarationFile[],
  cleanupErrors: Error[],
): Promise<void> {
  for (const owned of ownedFiles.toReversed()) {
    try {
      await rollbackOwnedFile(owned);
    } catch (error) {
      cleanupErrors.push(toError(error));
    }
  }
}

async function rollbackDirectories(
  ownedDirectories: readonly OwnedDeclarationDirectory[],
  cleanupErrors: Error[],
): Promise<void> {
  for (const owned of ownedDirectories.toReversed()) {
    try {
      await rollbackOwnedDirectory(owned);
    } catch (error) {
      cleanupErrors.push(toError(error));
    }
  }
}

function getInitialCleanupErrors(error: unknown): Error[] {
  if (error instanceof ExclusivePublicationError) {
    return [...error.cleanupErrors];
  }
  return [];
}

async function rollbackPublication(
  state: PublicationState,
  error: unknown,
): Promise<Error[]> {
  const cleanupErrors = getInitialCleanupErrors(error);
  await rollbackFiles(state.ownedFiles, cleanupErrors);
  await rollbackDirectories(state.ownedDirectories, cleanupErrors);
  return cleanupErrors;
}

function throwWithCleanupErrors(
  primaryError: unknown,
  cleanupErrors: readonly Error[],
): never {
  const primary = toError(primaryError);
  if (cleanupErrors.length === 0) throw primary;
  throw new AggregateError(
    [primary, ...cleanupErrors],
    `${primary.message}\nDeclaration rollback/cleanup also failed:\n${cleanupErrors
      .map((error) => `  - ${error.message}`)
      .join('\n')}`,
    { cause: primary },
  );
}

async function executePublication(options: {
  copyOptions: OutputDeclarationCopyOptions;
  prepared: PreparedDeclarationCollection;
}): Promise<void> {
  const state: PublicationState = {
    ownedDirectories: [],
    ownedFiles: [],
    transactionToken: randomUUID(),
  };
  const missingEntries = getMissingEntries(options.prepared.entries);
  try {
    await createParentDirectories(missingEntries, state);
    await assertPreparedEntriesCurrent(options.prepared.entries);
    await publishMissingEntries({
      copyOptions: options.copyOptions,
      entries: missingEntries,
      state,
    });
  } catch (error) {
    const cleanupErrors = await rollbackPublication(state, error);
    throwWithCleanupErrors(error, cleanupErrors);
  }
}

export async function copyOutputDeclarationInputs(
  plan: OutputDeclarationCopyPlan,
  options: OutputDeclarationCopyOptions,
): Promise<void> {
  assertPlanHasNoErrors(plan, options.projectRootDir);
  const prepared = await prepareValidatedCollection(plan, options);
  await assertPreparedEntriesCurrent(prepared.entries);
  await executePublication({ copyOptions: options, prepared });
}
