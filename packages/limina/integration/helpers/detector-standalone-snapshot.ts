import type { Stats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  getStandaloneIssueInvocationPath,
  readStandaloneIssueInvocation,
  toCheckIssueSnapshot,
} from '../../src/check-reporting/invocation-snapshot';
import { getCheckIssueSnapshotPath } from '../../src/check-reporting/snapshot';
import { isFreshSnapshotTimestamp } from './detector-check-snapshot';
import type {
  DetectorStructuredSnapshotResult,
  SnapshotReadOptions,
} from './detector-snapshot-types';
import { pathExists } from './fixture-sandbox';

export function getStandaloneInvocationDirectory(repoRoot: string): string {
  return path.join(
    path.dirname(getCheckIssueSnapshotPath(repoRoot)),
    'invocations',
  );
}

export function getExpectedStandaloneCommand(
  command: readonly string[],
): string {
  if (command[0] === 'checker' && command[1] === 'build') {
    return 'limina checker build';
  }
  throw new Error(
    `Detector fixture command does not produce a supported formal structured snapshot: ${JSON.stringify(command)}`,
  );
}

async function assertDirectory(
  pathValue: string,
  message: string,
): Promise<void> {
  const stats = await lstat(pathValue);
  if (stats.isDirectory() && !stats.isSymbolicLink()) return;
  throw new Error(message);
}

async function assertEmptyDirectory(
  directory: string,
  message: string,
): Promise<void> {
  const entries = await readdir(directory);
  if (entries.length === 0) return;
  throw new Error(message);
}

export async function assertNoPreexistingStandaloneSnapshots(
  repoRoot: string,
): Promise<void> {
  const invocationDirectory = getStandaloneInvocationDirectory(repoRoot);
  if (!(await pathExists(invocationDirectory))) return;
  await assertDirectory(
    invocationDirectory,
    `Detector fixture sandbox contains an invalid standalone invocation directory before invocation: ${invocationDirectory}`,
  );
  await assertEmptyDirectory(
    invocationDirectory,
    `Detector fixture sandbox contains stale standalone invocation snapshots before invocation: ${invocationDirectory}`,
  );
}

async function readInvocationEntry(options: {
  fixtureId: string;
  invocationDirectory: string;
}): Promise<string> {
  const entries = (
    await readdir(options.invocationDirectory, { withFileTypes: true })
  )
    .filter((entry) => entry.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name));
  const valid = entries.length === 1 && entries[0]!.isFile();
  if (valid) return entries[0]!.name.slice(0, -'.json'.length);
  throw new Error(
    `Detector fixture ${options.fixtureId} must produce exactly one formal standalone invocation snapshot in ${options.invocationDirectory}; received ${entries.length}.`,
  );
}

async function assertRealSnapshotFile(
  snapshotPath: string,
  fixtureId: string,
): Promise<Stats> {
  const snapshotStat = await lstat(snapshotPath);
  if (snapshotStat.isFile() && !snapshotStat.isSymbolicLink()) {
    return snapshotStat;
  }
  throw new Error(
    `Detector fixture ${fixtureId} standalone invocation snapshot is not a real file: ${snapshotPath}.`,
  );
}

async function resolveInvocationDirectory(
  options: SnapshotReadOptions,
): Promise<string> {
  const invocationDirectory = getStandaloneInvocationDirectory(
    options.repoRoot,
  );
  if (await pathExists(invocationDirectory)) return invocationDirectory;
  throw new Error(
    `Detector fixture ${options.fixtureId} did not produce a formal standalone invocation snapshot in ${invocationDirectory}.`,
  );
}

function assertStandaloneCommand(options: {
  expectedCommand: string;
  fixtureId: string;
  receivedCommand: string;
  snapshotPath: string;
}): void {
  if (options.receivedCommand === options.expectedCommand) return;
  throw new Error(
    `Detector fixture ${options.fixtureId} standalone invocation command mismatch at ${options.snapshotPath}: expected ${JSON.stringify(options.expectedCommand)}, received ${JSON.stringify(options.receivedCommand)}.`,
  );
}

function assertStandaloneFresh(options: {
  completedAt: string;
  fixtureId: string;
  invocationStartedAtMs: number;
  mtimeMs: number;
  snapshotPath: string;
}): void {
  const completedAtIsFresh = isFreshSnapshotTimestamp(
    Date.parse(options.completedAt),
    options.invocationStartedAtMs,
  );
  const fileIsFresh = isFreshSnapshotTimestamp(
    options.mtimeMs,
    options.invocationStartedAtMs,
  );
  if (completedAtIsFresh && fileIsFresh) return;
  throw new Error(
    `Detector fixture ${options.fixtureId} standalone invocation snapshot is stale: ${options.snapshotPath}.`,
  );
}

export async function readDetectorStandaloneInvocation(
  options: SnapshotReadOptions,
): Promise<DetectorStructuredSnapshotResult> {
  const invocationDirectory = await resolveInvocationDirectory(options);
  await assertDirectory(
    invocationDirectory,
    `Detector fixture ${options.fixtureId} produced an invalid standalone invocation directory: ${invocationDirectory}.`,
  );
  const invocationId = await readInvocationEntry({
    fixtureId: options.fixtureId,
    invocationDirectory,
  });
  const snapshotPath = getStandaloneIssueInvocationPath(
    options.repoRoot,
    invocationId,
  );
  const snapshotStat = await assertRealSnapshotFile(
    snapshotPath,
    options.fixtureId,
  );
  const invocation = await readStandaloneIssueInvocation(
    options.repoRoot,
    invocationId,
  );
  assertStandaloneCommand({
    expectedCommand: getExpectedStandaloneCommand(options.command),
    fixtureId: options.fixtureId,
    receivedCommand: invocation.command,
    snapshotPath,
  });
  assertStandaloneFresh({
    completedAt: invocation.completedAt,
    fixtureId: options.fixtureId,
    invocationStartedAtMs: options.invocationStartedAtMs,
    mtimeMs: snapshotStat.mtimeMs,
    snapshotPath,
  });
  return {
    kind: 'standalone-invocation',
    snapshot: toCheckIssueSnapshot(invocation),
    snapshotPath,
  };
}
