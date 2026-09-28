import { lstat, readFile } from 'node:fs/promises';

import {
  type CheckIssueSnapshot,
  getCheckIssueSnapshotPath,
  readCheckIssueSnapshot,
} from '../../src/check-reporting/snapshot';
import type { SnapshotReadOptions } from './detector-snapshot-types';
import { pathExists } from './fixture-sandbox';

export async function assertNoPreexistingCheckSnapshot(
  repoRoot: string,
): Promise<string> {
  const snapshotPath = getCheckIssueSnapshotPath(repoRoot);
  if (!(await pathExists(snapshotPath))) return snapshotPath;
  throw new Error(
    `Detector fixture sandbox contains a stale structured snapshot before invocation: ${snapshotPath}`,
  );
}

async function assertValidJsonFile(
  snapshotPath: string,
  fixtureId: string,
): Promise<void> {
  const snapshotText = await readFile(snapshotPath, 'utf8');
  try {
    JSON.parse(snapshotText);
  } catch (error) {
    throw new Error(
      `Detector fixture ${fixtureId} produced invalid JSON at ${snapshotPath}.`,
      { cause: error },
    );
  }
}

type CompletedCheckSnapshot = CheckIssueSnapshot & {
  run: NonNullable<CheckIssueSnapshot['run']>;
};

function hasCompletedRun(
  snapshot: CheckIssueSnapshot,
): snapshot is CompletedCheckSnapshot {
  if (snapshot.status !== 'completed') return false;
  return snapshot.run !== undefined;
}

function assertCompletedCheckSnapshot(options: {
  fixtureId: string;
  snapshot: CheckIssueSnapshot | null;
  snapshotPath: string;
}): asserts options is {
  fixtureId: string;
  snapshot: CompletedCheckSnapshot;
  snapshotPath: string;
} {
  if (options.snapshot === null) {
    throw new Error(
      `Detector fixture ${options.fixtureId} produced a snapshot that does not satisfy the formal current check schema at ${options.snapshotPath}.`,
    );
  }
  if (hasCompletedRun(options.snapshot)) return;
  throw new Error(
    `Detector fixture ${options.fixtureId} structured snapshot is not a completed check run: ${options.snapshotPath}.`,
  );
}

function assertCheckCommand(options: {
  command: readonly string[];
  fixtureId: string;
  snapshot: CompletedCheckSnapshot;
  snapshotPath: string;
}): void {
  const expectedCommand = `limina ${options.command.join(' ')}`;
  const commandsMatch =
    options.snapshot.command === expectedCommand &&
    options.snapshot.run.command === expectedCommand;
  if (commandsMatch) return;
  throw new Error(
    `Detector fixture ${options.fixtureId} snapshot command mismatch at ${options.snapshotPath}: expected ${JSON.stringify(expectedCommand)}, received snapshot=${JSON.stringify(options.snapshot.command)} run=${JSON.stringify(options.snapshot.run.command)}.`,
  );
}

export function isFreshSnapshotTimestamp(
  timestamp: number,
  invocationStartedAtMs: number,
): boolean {
  if (!Number.isFinite(timestamp)) return false;
  return timestamp >= invocationStartedAtMs - 1000;
}

async function assertCheckSnapshotFresh(options: {
  fixtureId: string;
  invocationStartedAtMs: number;
  snapshot: CheckIssueSnapshot;
  snapshotPath: string;
}): Promise<void> {
  const snapshotStat = await lstat(options.snapshotPath);
  const createdAtIsFresh = isFreshSnapshotTimestamp(
    Date.parse(options.snapshot.createdAt),
    options.invocationStartedAtMs,
  );
  const fileIsFresh = isFreshSnapshotTimestamp(
    snapshotStat.mtimeMs,
    options.invocationStartedAtMs,
  );
  if (createdAtIsFresh && fileIsFresh) return;
  throw new Error(
    `Detector fixture ${options.fixtureId} structured snapshot is stale: ${options.snapshotPath}.`,
  );
}

export async function readDetectorCheckSnapshot(
  options: SnapshotReadOptions,
): Promise<CheckIssueSnapshot> {
  const snapshotPath = getCheckIssueSnapshotPath(options.repoRoot);
  if (!(await pathExists(snapshotPath))) {
    throw new Error(
      `Detector fixture ${options.fixtureId} did not produce structured snapshot ${snapshotPath}.`,
    );
  }
  await assertValidJsonFile(snapshotPath, options.fixtureId);
  const snapshot = await readCheckIssueSnapshot(options.repoRoot);
  const assertion = { fixtureId: options.fixtureId, snapshot, snapshotPath };
  assertCompletedCheckSnapshot(assertion);
  assertCheckCommand({
    ...options,
    snapshot: assertion.snapshot,
    snapshotPath,
  });
  await assertCheckSnapshotFresh({
    ...options,
    snapshot: assertion.snapshot,
    snapshotPath,
  });
  return assertion.snapshot;
}
