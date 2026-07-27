import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'pathe';
import {
  type AtomicWriteOptions,
  writeJsonAtomically,
} from '../../check-reporting/atomic-writer';
import { generatedRootDirName } from '../../core/build-graph/generated/paths';
import {
  type LiminaArtifactNamespace,
  resolveArtifactNamespacePath,
} from '../../domain/artifacts/namespace';
import {
  assertWritableLiminaCheckIssue,
  isCheckInventoryOwner,
  isCurrentCheckIssueSnapshotStructure,
} from './issue-validation';
import {
  getCompletedRunSemanticProblem,
  getNotRunSummaryProblem,
} from './run-semantics';
import type {
  CheckIssueSnapshot,
  LiminaCheckIssue,
  LiminaCheckRunSummary,
} from './types';
import { CHECK_ISSUE_SNAPSHOT_VERSION } from './types';

export function getCheckIssueSnapshotPath(rootDir: string): string {
  return path.join(rootDir, generatedRootDirName, 'check', 'last-run.json');
}

function getCompletedRunError(run: LiminaCheckRunSummary): Error | null {
  const problem = getCompletedRunSemanticProblem(run);
  if (problem === null) return null;
  return new Error(`Invalid completed check run summary: ${problem}`);
}

function getNotRunError(run: LiminaCheckRunSummary): Error | null {
  if (getNotRunSummaryProblem(run) === null) return null;
  return new Error('Invalid not-run check snapshot model.');
}

function getSnapshotRunError(snapshot: CheckIssueSnapshot): Error | null {
  const run = snapshot.run;
  if (run === undefined) return null;
  return snapshot.status === 'completed'
    ? getCompletedRunError(run)
    : getNotRunError(run);
}

function assertSnapshotRun(snapshot: CheckIssueSnapshot): void {
  const error = getSnapshotRunError(snapshot);
  if (error !== null) throw error;
}

function assertSnapshotIssues(snapshot: CheckIssueSnapshot): void {
  for (const issue of snapshot.issues) assertWritableLiminaCheckIssue(issue);
}

export async function writeCheckIssueSnapshotOnly(
  namespace: LiminaArtifactNamespace,
  snapshot: CheckIssueSnapshot,
  atomicWriteOptions: AtomicWriteOptions = {},
): Promise<void> {
  if (!isCurrentCheckIssueSnapshotStructure(snapshot)) {
    throw new Error('Invalid v7 check snapshot wire model.');
  }
  assertSnapshotIssues(snapshot);
  assertSnapshotRun(snapshot);
  const snapshotPath = resolveArtifactNamespacePath(
    namespace,
    'check',
    'last-run.json',
  );
  await writeJsonAtomically(
    namespace,
    snapshotPath,
    snapshot,
    atomicWriteOptions,
  );
}

function createCheckSnapshot(options: {
  command: string;
  issues: readonly LiminaCheckIssue[];
  run?: LiminaCheckRunSummary;
  status: CheckIssueSnapshot['status'];
}): CheckIssueSnapshot {
  return {
    command: options.command,
    createdAt: new Date().toISOString(),
    issues: [...options.issues],
    run: options.run,
    status: options.status,
    version: CHECK_ISSUE_SNAPSHOT_VERSION,
  };
}

export async function writeNotRunCheckIssueSnapshot(options: {
  artifactNamespace: LiminaArtifactNamespace;
  command: string;
  rootDir: string;
  run?: LiminaCheckRunSummary;
}): Promise<void> {
  await writeCheckIssueSnapshotOnly(
    options.artifactNamespace,
    createCheckSnapshot({
      command: options.command,
      issues: [],
      run: options.run,
      status: 'not-run',
    }),
  );
}

export async function writeCompletedCheckIssueSnapshot(options: {
  artifactNamespace: LiminaArtifactNamespace;
  command: string;
  issues?: readonly LiminaCheckIssue[];
  rootDir: string;
  run?: LiminaCheckRunSummary;
}): Promise<void> {
  await writeCheckIssueSnapshotOnly(
    options.artifactNamespace,
    createCheckSnapshot({
      command: options.command,
      issues: options.issues ?? [],
      run: options.run,
      status: 'completed',
    }),
  );
}

function resolveCurrentCommand(
  current: CheckIssueSnapshot,
  command: string | undefined,
): string {
  if (command !== undefined) return command;
  return current.command;
}

export async function completeCheckIssueSnapshot(options: {
  artifactNamespace: LiminaArtifactNamespace;
  command?: string;
  rootDir: string;
  run?: LiminaCheckRunSummary;
}): Promise<void> {
  const current = await readCheckIssueSnapshot(options.rootDir);
  if (current === null) return;
  await writeCompletedCheckIssueSnapshot({
    artifactNamespace: options.artifactNamespace,
    command: resolveCurrentCommand(current, options.command),
    issues: current.issues,
    rootDir: options.rootDir,
    run: options.run ?? current.run,
  });
}

function getAppendedCommand(options: {
  command: string | undefined;
  current: CheckIssueSnapshot | null;
}): string {
  if (options.command !== undefined) return options.command;
  if (options.current !== null) return options.current.command;
  return 'limina check';
}

function getCurrentIssues(
  current: CheckIssueSnapshot | null,
): readonly LiminaCheckIssue[] {
  return current === null ? [] : current.issues;
}

function getCurrentStatus(
  current: CheckIssueSnapshot | null,
): CheckIssueSnapshot['status'] {
  return current === null ? 'completed' : current.status;
}

function getCurrentRun(
  current: CheckIssueSnapshot | null,
): LiminaCheckRunSummary | undefined {
  return current === null ? undefined : current.run;
}

function createAppendedSnapshot(options: {
  command: string | undefined;
  current: CheckIssueSnapshot | null;
  issues: readonly LiminaCheckIssue[];
}): CheckIssueSnapshot {
  return {
    command: getAppendedCommand(options),
    createdAt: new Date().toISOString(),
    issues: [...getCurrentIssues(options.current), ...options.issues],
    run: getCurrentRun(options.current),
    status: getCurrentStatus(options.current),
    version: CHECK_ISSUE_SNAPSHOT_VERSION,
  };
}

export async function appendCheckIssues(options: {
  artifactNamespace: LiminaArtifactNamespace;
  command?: string;
  issues: readonly LiminaCheckIssue[];
  rootDir: string;
}): Promise<void> {
  if (options.issues.length === 0) return;
  const current = await readCheckIssueSnapshot(options.rootDir);
  await writeCheckIssueSnapshotOnly(
    options.artifactNamespace,
    createAppendedSnapshot({
      command: options.command,
      current,
      issues: options.issues,
    }),
  );
}

export async function appendTaskFailureIssueIfMissing(options: {
  artifactNamespace: LiminaArtifactNamespace;
  command?: string;
  issue: LiminaCheckIssue;
  rootDir: string;
}): Promise<void> {
  const current = await readCheckIssueSnapshot(options.rootDir);
  const alreadyPresent = current?.issues.some(
    (issue) => issue.task === options.issue.task,
  );
  if (alreadyPresent === true) return;
  await appendCheckIssues({
    artifactNamespace: options.artifactNamespace,
    command: options.command,
    issues: [options.issue],
    rootDir: options.rootDir,
  });
}

function hasValidSnapshotSemantics(snapshot: CheckIssueSnapshot): boolean {
  const run = snapshot.run;
  if (run === undefined) return true;
  if (snapshot.status === 'completed') {
    return getCompletedRunSemanticProblem(run) === null;
  }
  return getNotRunSummaryProblem(run) === null;
}

function getOwnedSnapshot(
  snapshot: CheckIssueSnapshot,
): CheckIssueSnapshot | null {
  return isCheckInventoryOwner(snapshot) ? snapshot : null;
}

function validateParsedCheckSnapshot(
  parsed: unknown,
): CheckIssueSnapshot | null {
  if (!isCurrentCheckIssueSnapshotStructure(parsed)) return null;
  if (!hasValidSnapshotSemantics(parsed)) return null;
  return getOwnedSnapshot(parsed);
}

async function parseCheckIssueSnapshot(
  snapshotPath: string,
): Promise<CheckIssueSnapshot | null> {
  try {
    const parsed = JSON.parse(await readFile(snapshotPath, 'utf8')) as unknown;
    return validateParsedCheckSnapshot(parsed);
  } catch {
    return null;
  }
}

export async function readCheckIssueSnapshot(
  rootDir: string,
): Promise<CheckIssueSnapshot | null> {
  const snapshotPath = getCheckIssueSnapshotPath(rootDir);
  if (!existsSync(snapshotPath)) return null;
  return parseCheckIssueSnapshot(snapshotPath);
}
