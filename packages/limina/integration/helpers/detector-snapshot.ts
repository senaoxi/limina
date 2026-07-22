import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  getStandaloneIssueInvocationPath,
  readStandaloneIssueInvocation,
  toCheckIssueSnapshot,
} from '../../src/check-reporting/invocation-snapshot';
import {
  type CheckIssueSnapshot,
  getCheckIssueSnapshotPath,
  readCheckIssueSnapshot,
} from '../../src/check-reporting/snapshot';
import { pathExists } from './fixture-sandbox';

export type DetectorStructuredSnapshotKind =
  | 'check-run'
  | 'standalone-invocation';

export interface DetectorStructuredSnapshotResult {
  readonly kind: DetectorStructuredSnapshotKind;
  readonly snapshot: CheckIssueSnapshot;
  readonly snapshotPath: string;
}

function getStandaloneInvocationDirectory(repoRoot: string): string {
  return path.join(
    path.dirname(getCheckIssueSnapshotPath(repoRoot)),
    'invocations',
  );
}

function getExpectedStandaloneCommand(command: readonly string[]): string {
  if (command[0] === 'checker' && command[1] === 'build') {
    return 'limina checker build';
  }

  throw new Error(
    `Detector fixture command does not produce a supported formal structured snapshot: ${JSON.stringify(command)}`,
  );
}

export function getDetectorStructuredSnapshotKind(
  command: readonly string[],
): DetectorStructuredSnapshotKind {
  if (command[0] === 'check') {
    return 'check-run';
  }

  getExpectedStandaloneCommand(command);
  return 'standalone-invocation';
}

export async function assertNoPreexistingCheckSnapshot(
  repoRoot: string,
): Promise<string> {
  const snapshotPath = getCheckIssueSnapshotPath(repoRoot);
  if (await pathExists(snapshotPath)) {
    throw new Error(
      `Detector fixture sandbox contains a stale structured snapshot before invocation: ${snapshotPath}`,
    );
  }

  return snapshotPath;
}

export async function assertNoPreexistingDetectorSnapshots(
  repoRoot: string,
): Promise<void> {
  await assertNoPreexistingCheckSnapshot(repoRoot);

  const invocationDirectory = getStandaloneInvocationDirectory(repoRoot);
  if (!(await pathExists(invocationDirectory))) {
    return;
  }

  const directoryStat = await lstat(invocationDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(
      `Detector fixture sandbox contains an invalid standalone invocation directory before invocation: ${invocationDirectory}`,
    );
  }

  const entries = await readdir(invocationDirectory);
  if (entries.length > 0) {
    throw new Error(
      `Detector fixture sandbox contains stale standalone invocation snapshots before invocation: ${invocationDirectory}`,
    );
  }
}

export async function readDetectorCheckSnapshot(options: {
  readonly command: readonly string[];
  readonly fixtureId: string;
  readonly invocationStartedAtMs: number;
  readonly repoRoot: string;
}): Promise<CheckIssueSnapshot> {
  const snapshotPath = getCheckIssueSnapshotPath(options.repoRoot);
  if (!(await pathExists(snapshotPath))) {
    throw new Error(
      `Detector fixture ${options.fixtureId} did not produce structured snapshot ${snapshotPath}.`,
    );
  }

  const snapshotText = await readFile(snapshotPath, 'utf8');
  try {
    JSON.parse(snapshotText);
  } catch (error) {
    throw new Error(
      `Detector fixture ${options.fixtureId} produced invalid JSON at ${snapshotPath}.`,
      { cause: error },
    );
  }

  const snapshot = await readCheckIssueSnapshot(options.repoRoot);
  if (!snapshot) {
    throw new Error(
      `Detector fixture ${options.fixtureId} produced a snapshot that does not satisfy the formal current check schema at ${snapshotPath}.`,
    );
  }
  if (snapshot.status !== 'completed' || !snapshot.run) {
    throw new Error(
      `Detector fixture ${options.fixtureId} structured snapshot is not a completed check run: ${snapshotPath}.`,
    );
  }

  const expectedCommand = `limina ${options.command.join(' ')}`;
  if (
    snapshot.command !== expectedCommand ||
    snapshot.run.command !== expectedCommand
  ) {
    throw new Error(
      `Detector fixture ${options.fixtureId} snapshot command mismatch at ${snapshotPath}: expected ${JSON.stringify(expectedCommand)}, received snapshot=${JSON.stringify(snapshot.command)} run=${JSON.stringify(snapshot.run.command)}.`,
    );
  }

  const createdAtMs = Date.parse(snapshot.createdAt);
  const snapshotStat = await lstat(snapshotPath);
  if (
    !Number.isFinite(createdAtMs) ||
    createdAtMs < options.invocationStartedAtMs - 1000 ||
    snapshotStat.mtimeMs < options.invocationStartedAtMs - 1000
  ) {
    throw new Error(
      `Detector fixture ${options.fixtureId} structured snapshot is stale: ${snapshotPath}.`,
    );
  }

  return snapshot;
}

async function readDetectorStandaloneInvocation(options: {
  readonly command: readonly string[];
  readonly fixtureId: string;
  readonly invocationStartedAtMs: number;
  readonly repoRoot: string;
}): Promise<DetectorStructuredSnapshotResult> {
  const invocationDirectory = getStandaloneInvocationDirectory(
    options.repoRoot,
  );
  if (!(await pathExists(invocationDirectory))) {
    throw new Error(
      `Detector fixture ${options.fixtureId} did not produce a formal standalone invocation snapshot in ${invocationDirectory}.`,
    );
  }

  const directoryStat = await lstat(invocationDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(
      `Detector fixture ${options.fixtureId} produced an invalid standalone invocation directory: ${invocationDirectory}.`,
    );
  }

  const entries = (await readdir(invocationDirectory, { withFileTypes: true }))
    .filter((entry) => entry.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length !== 1 || !entries[0]!.isFile()) {
    throw new Error(
      `Detector fixture ${options.fixtureId} must produce exactly one formal standalone invocation snapshot in ${invocationDirectory}; received ${entries.length}.`,
    );
  }

  const invocationId = entries[0]!.name.slice(0, -'.json'.length);
  const snapshotPath = getStandaloneIssueInvocationPath(
    options.repoRoot,
    invocationId,
  );
  const snapshotStat = await lstat(snapshotPath);
  if (!snapshotStat.isFile() || snapshotStat.isSymbolicLink()) {
    throw new Error(
      `Detector fixture ${options.fixtureId} standalone invocation snapshot is not a real file: ${snapshotPath}.`,
    );
  }

  const invocation = await readStandaloneIssueInvocation(
    options.repoRoot,
    invocationId,
  );
  const expectedCommand = getExpectedStandaloneCommand(options.command);
  if (invocation.command !== expectedCommand) {
    throw new Error(
      `Detector fixture ${options.fixtureId} standalone invocation command mismatch at ${snapshotPath}: expected ${JSON.stringify(expectedCommand)}, received ${JSON.stringify(invocation.command)}.`,
    );
  }

  const completedAtMs = Date.parse(invocation.completedAt);
  if (
    !Number.isFinite(completedAtMs) ||
    completedAtMs < options.invocationStartedAtMs - 1000 ||
    snapshotStat.mtimeMs < options.invocationStartedAtMs - 1000
  ) {
    throw new Error(
      `Detector fixture ${options.fixtureId} standalone invocation snapshot is stale: ${snapshotPath}.`,
    );
  }

  return {
    kind: 'standalone-invocation',
    snapshot: toCheckIssueSnapshot(invocation),
    snapshotPath,
  };
}

export async function readDetectorStructuredSnapshot(options: {
  readonly command: readonly string[];
  readonly fixtureId: string;
  readonly invocationStartedAtMs: number;
  readonly repoRoot: string;
}): Promise<DetectorStructuredSnapshotResult> {
  if (getDetectorStructuredSnapshotKind(options.command) === 'check-run') {
    return {
      kind: 'check-run',
      snapshot: await readDetectorCheckSnapshot(options),
      snapshotPath: getCheckIssueSnapshotPath(options.repoRoot),
    };
  }

  return readDetectorStandaloneInvocation(options);
}
