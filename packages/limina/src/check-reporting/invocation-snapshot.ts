import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'pathe';
import { generatedRootDirName } from '../core/build-graph/generated/paths';
import {
  type LiminaArtifactNamespace,
  resolveArtifactNamespacePath,
} from '../domain/artifacts/namespace';
import {
  CHECK_ISSUE_SNAPSHOT_VERSION,
  type CheckIssueInventoryInvocationMetadata,
  type CheckIssueSnapshot,
  isLiminaCheckIssue,
  type LiminaCheckIssue,
} from '../source-check/snapshot';
import { writeJsonAtomically } from './atomic-writer';
import { LiminaStructuredError } from './errors';

export const STANDALONE_ISSUE_INVOCATION_VERSION = 1;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface StandaloneIssueInvocationSnapshot {
  command: string;
  completedAt: string;
  invocationId: string;
  issues: LiminaCheckIssue[];
  kind: 'standalone-invocation';
  result: 'failed';
  version: typeof STANDALONE_ISSUE_INVOCATION_VERSION;
}

export class StandaloneIssueInvocationNotFoundError extends Error {
  override readonly name = 'StandaloneIssueInvocationNotFoundError';
}

export class StandaloneIssueInvocationInvalidError extends Error {
  override readonly name = 'StandaloneIssueInvocationInvalidError';
}

export function isStandaloneIssueInvocationId(value: string): boolean {
  return UUID_V4_PATTERN.test(value);
}

export function toCheckIssueSnapshot(
  invocation: StandaloneIssueInvocationSnapshot,
): CheckIssueSnapshot {
  return {
    command: invocation.command,
    createdAt: invocation.completedAt,
    issues: invocation.issues,
    status: 'completed',
    version: CHECK_ISSUE_SNAPSHOT_VERSION,
  };
}

export function toCheckIssueInventoryInvocationMetadata(
  invocation: StandaloneIssueInvocationSnapshot,
): CheckIssueInventoryInvocationMetadata {
  return {
    completedAt: invocation.completedAt,
    invocationId: invocation.invocationId,
    kind: invocation.kind,
    result: invocation.result,
    version: invocation.version,
  };
}

export function getStandaloneIssueInvocationPath(
  rootDir: string,
  invocationId: string,
): string {
  if (!isStandaloneIssueInvocationId(invocationId)) {
    throw new StandaloneIssueInvocationInvalidError(
      `Invalid standalone issue invocation ID: ${invocationId}.`,
    );
  }

  return path.join(
    rootDir,
    generatedRootDirName,
    'check',
    'invocations',
    `${invocationId}.json`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasValidSnapshotMetadata(record: Record<string, unknown>): boolean {
  return [
    record.kind === 'standalone-invocation',
    record.version === STANDALONE_ISSUE_INVOCATION_VERSION,
    typeof record.invocationId === 'string',
    typeof record.command === 'string',
    typeof record.completedAt === 'string',
    record.result === 'failed',
  ].every(Boolean);
}

function hasValidInvocationId(record: Record<string, unknown>): boolean {
  return (
    typeof record.invocationId === 'string' &&
    isStandaloneIssueInvocationId(record.invocationId)
  );
}

function hasValidIssues(record: Record<string, unknown>): boolean {
  return (
    Array.isArray(record.issues) && record.issues.every(isLiminaCheckIssue)
  );
}

function isStandaloneIssueInvocationSnapshot(
  value: unknown,
): value is StandaloneIssueInvocationSnapshot {
  if (!isRecord(value)) {
    return false;
  }

  return [
    hasValidSnapshotMetadata(value),
    hasValidInvocationId(value),
    hasValidIssues(value),
  ].every(Boolean);
}

function collectStructuredErrorIssues(error: unknown): LiminaCheckIssue[] {
  return error instanceof LiminaStructuredError ? error.issues : [];
}

function addIssueIfUnique(
  issue: LiminaCheckIssue,
  seenIds: Set<string>,
  merged: LiminaCheckIssue[],
): void {
  const issueId = issue.id;

  if (issueId === undefined) {
    merged.push(issue);
    return;
  }

  if (seenIds.has(issueId)) {
    return;
  }

  seenIds.add(issueId);
  merged.push(issue);
}

export function mergeStandaloneFailureIssues(options: {
  error?: unknown;
  issues: readonly LiminaCheckIssue[];
}): LiminaCheckIssue[] {
  const seenIds = new Set<string>();
  const merged: LiminaCheckIssue[] = [];
  const issues = [
    ...options.issues,
    ...collectStructuredErrorIssues(options.error),
  ];

  for (const issue of issues) {
    addIssueIfUnique(issue, seenIds, merged);
  }

  return merged;
}

function createInvocationId(rootDir: string): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const invocationId = randomUUID();

    if (!existsSync(getStandaloneIssueInvocationPath(rootDir, invocationId))) {
      return invocationId;
    }
  }

  throw new Error('Unable to allocate a standalone issue invocation ID.');
}

function selectFailureIssues(options: {
  createFallbackIssue: () => LiminaCheckIssue;
  error?: unknown;
  issues: readonly LiminaCheckIssue[];
}): LiminaCheckIssue[] {
  const mergedIssues = mergeStandaloneFailureIssues(options);

  return mergedIssues.length > 0
    ? mergedIssues
    : [options.createFallbackIssue()];
}

export async function writeStandaloneFailureInvocation(options: {
  artifactNamespace: LiminaArtifactNamespace;
  command: string;
  createFallbackIssue: () => LiminaCheckIssue;
  error?: unknown;
  issues: readonly LiminaCheckIssue[];
  rootDir: string;
}): Promise<StandaloneIssueInvocationSnapshot> {
  const invocationId = createInvocationId(options.rootDir);
  const snapshot: StandaloneIssueInvocationSnapshot = {
    command: options.command,
    completedAt: new Date().toISOString(),
    invocationId,
    issues: selectFailureIssues(options),
    kind: 'standalone-invocation',
    result: 'failed',
    version: STANDALONE_ISSUE_INVOCATION_VERSION,
  };
  const snapshotPath = resolveArtifactNamespacePath(
    options.artifactNamespace,
    'check',
    'invocations',
    `${invocationId}.json`,
  );

  await writeJsonAtomically(options.artifactNamespace, snapshotPath, snapshot);
  return snapshot;
}

function assertValidInvocationSnapshot(
  parsed: unknown,
  invocationId: string,
): asserts parsed is StandaloneIssueInvocationSnapshot {
  const matchesInvocation =
    isStandaloneIssueInvocationSnapshot(parsed) &&
    parsed.invocationId === invocationId;

  if (!matchesInvocation) {
    throw new StandaloneIssueInvocationInvalidError(
      `Invalid standalone issue invocation record for ${invocationId}.`,
    );
  }
}

async function readInvocationSnapshotFile(
  snapshotPath: string,
  invocationId: string,
): Promise<StandaloneIssueInvocationSnapshot> {
  const parsed = JSON.parse(await readFile(snapshotPath, 'utf8')) as unknown;

  assertValidInvocationSnapshot(parsed, invocationId);
  return parsed;
}

function wrapInvocationReadError(
  error: unknown,
  invocationId: string,
): StandaloneIssueInvocationInvalidError {
  if (error instanceof StandaloneIssueInvocationInvalidError) {
    return error;
  }

  return new StandaloneIssueInvocationInvalidError(
    `Unable to read standalone issue invocation ${invocationId}.`,
    { cause: error },
  );
}

export async function readStandaloneIssueInvocation(
  rootDir: string,
  invocationId: string,
): Promise<StandaloneIssueInvocationSnapshot> {
  const snapshotPath = getStandaloneIssueInvocationPath(rootDir, invocationId);

  if (!existsSync(snapshotPath)) {
    throw new StandaloneIssueInvocationNotFoundError(
      `No standalone issue invocation found for ${invocationId}.`,
    );
  }

  try {
    return await readInvocationSnapshotFile(snapshotPath, invocationId);
  } catch (error) {
    throw wrapInvocationReadError(error, invocationId);
  }
}
