import type { Dirent } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'pathe';
import type { LiminaArtifactNamespace } from '../../domain/artifacts/namespace';
import type { CrossProcessLeaseOwner } from '../../utils/mutation/cross-process-lease';
import {
  type CheckAttemptStarted,
  type CheckAttemptStatus,
  getCheckAttemptPaths,
  getIndexPaths,
  hasCode,
  isLatestAttempt,
  isLatestCompleted,
  isStarted,
  isStatus,
  readCheckAttemptJson,
  type ReadJsonResult,
} from './check-attempt-metadata';

const ATTEMPT_RETENTION_COUNT = 32;
const ATTEMPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

interface RetentionEntry {
  attemptDir: string;
  started: CheckAttemptStarted;
  status: ReadJsonResult<CheckAttemptStatus>;
}

function isOwnerDefinitelyDead(owner: CrossProcessLeaseOwner): boolean {
  if (owner.hostname !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return hasCode(error, 'ESRCH');
  }
}

async function readRetentionEntry(
  attemptsDir: string,
  entry: Dirent,
): Promise<RetentionEntry | null> {
  if (!entry.isDirectory()) return null;
  const attemptDir = path.join(attemptsDir, entry.name);
  const started = await readCheckAttemptJson(
    path.join(attemptDir, 'started.json'),
    isStarted,
  );
  if (started.status !== 'valid') return null;
  return {
    attemptDir,
    started: started.value,
    status: await readCheckAttemptJson(
      path.join(attemptDir, 'status.json'),
      isStatus,
    ),
  };
}

async function collectRetentionEntries(
  attemptsDir: string,
): Promise<RetentionEntry[]> {
  const directoryEntries = await readAttemptDirectories(attemptsDir);
  const entries: RetentionEntry[] = [];
  for (const directoryEntry of directoryEntries) {
    const entry = await readRetentionEntry(attemptsDir, directoryEntry);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

async function readAttemptDirectories(attemptsDir: string): Promise<Dirent[]> {
  try {
    return await readdir(attemptsDir, { withFileTypes: true });
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return [];
    throw error;
  }
}

async function collectPreservedAttemptIds(
  namespace: LiminaArtifactNamespace,
): Promise<Set<string>> {
  const preserved = new Set<string>();
  const paths = getIndexPaths(namespace);
  const latest = await readCheckAttemptJson(
    paths.latestAttempt,
    isLatestAttempt,
  );
  if (latest.status === 'valid') preserved.add(latest.value.attemptId);
  const completed = await readCheckAttemptJson(
    paths.latestCompleted,
    isLatestCompleted,
  );
  if (completed.status === 'valid') preserved.add(completed.value.attemptId);
  return preserved;
}

function isTerminalOrDead(entry: RetentionEntry): boolean {
  if (entry.status.status === 'corrupt') return false;
  if (entry.status.status === 'valid') return true;
  return isOwnerDefinitelyDead(entry.started.owner);
}

function canRemoveEntry(
  entry: RetentionEntry,
  preserved: ReadonlySet<string>,
  cutoff: number,
): boolean {
  if (preserved.has(entry.started.attemptId)) return false;
  if (Date.parse(entry.started.startedAt) >= cutoff) return false;
  return isTerminalOrDead(entry);
}

function preserveNewest(
  entries: readonly RetentionEntry[],
  preserved: Set<string>,
): void {
  const newest = [...entries]
    .sort((left, right) => right.started.sequence - left.started.sequence)
    .slice(0, ATTEMPT_RETENTION_COUNT);
  for (const entry of newest) preserved.add(entry.started.attemptId);
}

export async function cleanupAttemptRetention(
  namespace: LiminaArtifactNamespace,
): Promise<void> {
  const attemptsDir = getCheckAttemptPaths(namespace.configRootDir).attemptsDir;
  const entries = await collectRetentionEntries(attemptsDir);
  const preserved = await collectPreservedAttemptIds(namespace);
  preserveNewest(entries, preserved);
  const cutoff = Date.now() - ATTEMPT_RETENTION_MS;
  for (const entry of entries) {
    if (!canRemoveEntry(entry, preserved, cutoff)) continue;
    await rm(entry.attemptDir, { force: true, recursive: true });
  }
}
