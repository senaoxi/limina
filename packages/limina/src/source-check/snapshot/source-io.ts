import { normalizeSlashes, toRelativePath } from '#utils/path';
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
import type { SourceCheckIssue } from '../report';
import { isSourceIssueSnapshot } from './issue-validation';
import type {
  SourceIssueSnapshot,
  SourceIssueSnapshotIssue,
  SourceIssueSnapshotStatus,
} from './types';
import { SOURCE_ISSUE_SNAPSHOT_VERSION } from './types';

function createSnapshot(options: {
  command: string;
  issues: SourceIssueSnapshotIssue[];
  status: SourceIssueSnapshotStatus;
}): SourceIssueSnapshot {
  return {
    command: options.command,
    createdAt: new Date().toISOString(),
    issues: options.issues,
    status: options.status,
    version: SOURCE_ISSUE_SNAPSHOT_VERSION,
  };
}

function getIssueFilePath(issue: SourceCheckIssue): string | undefined {
  if (!('filePath' in issue)) return undefined;
  return issue.filePath;
}

function toSnapshotIssue(
  rootDir: string,
  issue: SourceCheckIssue,
): SourceIssueSnapshotIssue {
  const filePath = getIssueFilePath(issue);
  return {
    code: issue.code,
    ...(filePath === undefined
      ? {}
      : { filePath: normalizeSlashes(toRelativePath(rootDir, filePath)) }),
    ownerName: issue.ownerName,
  };
}

export function createCompletedSourceIssueSnapshot(options: {
  command: string;
  issues: readonly SourceCheckIssue[];
  rootDir: string;
}): SourceIssueSnapshot {
  return createSnapshot({
    command: options.command,
    issues: options.issues.map((issue) =>
      toSnapshotIssue(options.rootDir, issue),
    ),
    status: 'completed',
  });
}

export function createNotRunSourceIssueSnapshot(
  command: string,
): SourceIssueSnapshot {
  return createSnapshot({ command, issues: [], status: 'not-run' });
}

export function getSourceIssueSnapshotPath(rootDir: string): string {
  return path.join(
    rootDir,
    generatedRootDirName,
    'source-check',
    'last-run.json',
  );
}

export async function writeSourceIssueSnapshotOnly(
  namespace: LiminaArtifactNamespace,
  snapshot: SourceIssueSnapshot,
  atomicWriteOptions: AtomicWriteOptions = {},
): Promise<void> {
  const snapshotPath = resolveArtifactNamespacePath(
    namespace,
    'source-check',
    'last-run.json',
  );
  await writeJsonAtomically(
    namespace,
    snapshotPath,
    snapshot,
    atomicWriteOptions,
  );
}

export async function writeNotRunSourceIssueSnapshot(options: {
  artifactNamespace: LiminaArtifactNamespace;
  command: string;
  rootDir: string;
}): Promise<void> {
  await writeSourceIssueSnapshotOnly(
    options.artifactNamespace,
    createNotRunSourceIssueSnapshot(options.command),
  );
}

export async function writeCompletedStandaloneSourceCheckSnapshots(options: {
  artifactNamespace: LiminaArtifactNamespace;
  command: string;
  issues: readonly SourceCheckIssue[];
  rootDir: string;
}): Promise<void> {
  await writeSourceIssueSnapshotOnly(
    options.artifactNamespace,
    createCompletedSourceIssueSnapshot(options),
  );
}

async function parseSourceIssueSnapshot(
  snapshotPath: string,
): Promise<SourceIssueSnapshot | null> {
  try {
    const parsed = JSON.parse(await readFile(snapshotPath, 'utf8')) as unknown;
    return isSourceIssueSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function readSourceIssueSnapshot(
  rootDir: string,
): Promise<SourceIssueSnapshot | null> {
  const snapshotPath = getSourceIssueSnapshotPath(rootDir);
  if (!existsSync(snapshotPath)) return null;
  return parseSourceIssueSnapshot(snapshotPath);
}
