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

function isStandaloneIssueInvocationSnapshot(
  value: unknown,
): value is StandaloneIssueInvocationSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    record.kind === 'standalone-invocation' &&
    record.version === STANDALONE_ISSUE_INVOCATION_VERSION &&
    typeof record.invocationId === 'string' &&
    isStandaloneIssueInvocationId(record.invocationId) &&
    typeof record.command === 'string' &&
    typeof record.completedAt === 'string' &&
    record.result === 'failed' &&
    Array.isArray(record.issues) &&
    record.issues.every(isLiminaCheckIssue)
  );
}

export function mergeStandaloneFailureIssues(options: {
  error?: unknown;
  issues: readonly LiminaCheckIssue[];
}): LiminaCheckIssue[] {
  const structuredIssues =
    options.error instanceof LiminaStructuredError ? options.error.issues : [];
  const seenIds = new Set<string>();
  const merged: LiminaCheckIssue[] = [];

  for (const issue of [...options.issues, ...structuredIssues]) {
    if (issue.id) {
      if (seenIds.has(issue.id)) {
        continue;
      }
      seenIds.add(issue.id);
    }

    merged.push(issue);
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

export async function writeStandaloneFailureInvocation(options: {
  artifactNamespace: LiminaArtifactNamespace;
  command: string;
  createFallbackIssue: () => LiminaCheckIssue;
  error?: unknown;
  issues: readonly LiminaCheckIssue[];
  rootDir: string;
}): Promise<StandaloneIssueInvocationSnapshot> {
  const mergedIssues = mergeStandaloneFailureIssues(options);
  const issues =
    mergedIssues.length > 0 ? mergedIssues : [options.createFallbackIssue()];
  const invocationId = createInvocationId(options.rootDir);
  const snapshot: StandaloneIssueInvocationSnapshot = {
    command: options.command,
    completedAt: new Date().toISOString(),
    invocationId,
    issues,
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
    const parsed = JSON.parse(await readFile(snapshotPath, 'utf8')) as unknown;

    if (
      !isStandaloneIssueInvocationSnapshot(parsed) ||
      parsed.invocationId !== invocationId
    ) {
      throw new StandaloneIssueInvocationInvalidError(
        `Invalid standalone issue invocation record for ${invocationId}.`,
      );
    }

    return parsed;
  } catch (error) {
    if (error instanceof StandaloneIssueInvocationInvalidError) {
      throw error;
    }

    throw new StandaloneIssueInvocationInvalidError(
      `Unable to read standalone issue invocation ${invocationId}.`,
      { cause: error },
    );
  }
}
