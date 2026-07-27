import type { ResolvedLiminaConfig } from '#config/runner';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  normalizeSlashes,
  toRelativePath,
} from '#utils/path';
import { existsSync, realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'pathe';
import type { LiminaWritableCheckIssueCode } from '../../../check-reporting/codes';
import { createLiminaCheckIssue } from '../../../check-reporting/structured';
import type { LiminaCheckIssue } from '../../../source-check/snapshot';
import type {
  WorkspaceDescriptorCandidate,
  WorkspaceDescriptorKind,
} from './types';

export function findNearestPnpmWorkspaceRoot(startDir: string): string {
  let currentDir = normalizeAbsolutePath(startDir);
  while (!existsSync(path.join(currentDir, 'pnpm-workspace.yaml'))) {
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(
        `No pnpm-workspace.yaml was found from ${normalizeAbsolutePath(startDir)} or its ancestors.`,
      );
    }
    currentDir = parentDir;
  }
  return currentDir;
}

export function isInsideOrEqual(
  parentPath: string,
  childPath: string,
): boolean {
  const normalizedParent = normalizeAbsolutePath(parentPath);
  const normalizedChild = normalizeAbsolutePath(childPath);
  if (normalizedParent === normalizedChild) return true;
  return isPathInsideDirectory(normalizedChild, normalizedParent);
}

export function displayWorkspacePath(
  rootDir: string,
  targetPath: string,
): string {
  return normalizeSlashes(toRelativePath(rootDir, targetPath));
}

function createWorkspaceEvidence(evidence: readonly string[] | undefined): {
  evidence?: { label: string; lines: string[] }[];
} {
  if (evidence === undefined) return {};
  if (evidence.length === 0) return {};
  return {
    evidence: [{ label: 'workspace validation', lines: [...evidence] }],
  };
}

export function createWorkspaceIssue(options: {
  code: LiminaWritableCheckIssueCode;
  config: ResolvedLiminaConfig;
  evidence?: readonly string[];
  filePath?: string;
  fix: string;
  reason: string;
  title: string;
}): LiminaCheckIssue {
  return createLiminaCheckIssue({
    code: options.code,
    ...createWorkspaceEvidence(options.evidence),
    filePath: options.filePath,
    fix: options.fix,
    reason: options.reason,
    rootDir: options.config.rootDir,
    task: 'workspace:validate',
    title: options.title,
    verifyCommands: ['limina check'],
  });
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function tryCanonicalPath(
  cursor: string,
  suffix: readonly string[],
): Promise<string | null> {
  try {
    return normalizeAbsolutePath(
      path.join(await realpath(cursor), ...suffix.toReversed()),
    );
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

async function resolveCanonicalPath(options: {
  cursor: string;
  suffix: readonly string[];
  targetPath: string;
}): Promise<string> {
  const canonicalPath = await tryCanonicalPath(options.cursor, options.suffix);
  if (canonicalPath !== null) return canonicalPath;
  const parent = path.dirname(options.cursor);
  if (parent === options.cursor) {
    throw new Error(`No existing ancestor for ${options.targetPath}.`);
  }
  return resolveCanonicalPath({
    cursor: parent,
    suffix: [...options.suffix, path.basename(options.cursor)],
    targetPath: options.targetPath,
  });
}

export function canonicalProjectedPath(targetPath: string): Promise<string> {
  return resolveCanonicalPath({
    cursor: normalizeAbsolutePath(targetPath),
    suffix: [],
    targetPath,
  });
}

function tryCanonicalPathSync(
  cursor: string,
  suffix: readonly string[],
): string | null {
  try {
    return normalizeAbsolutePath(
      path.join(realpathSync.native(cursor), ...suffix.toReversed()),
    );
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

function resolveCanonicalPathSync(options: {
  cursor: string;
  normalizedTarget: string;
  suffix: readonly string[];
}): string {
  const canonicalPath = tryCanonicalPathSync(options.cursor, options.suffix);
  if (canonicalPath !== null) return canonicalPath;
  const parent = path.dirname(options.cursor);
  if (parent === options.cursor) return options.normalizedTarget;
  return resolveCanonicalPathSync({
    cursor: parent,
    normalizedTarget: options.normalizedTarget,
    suffix: [...options.suffix, path.basename(options.cursor)],
  });
}

export function canonicalProjectedPathSync(targetPath: string): string {
  const normalizedTarget = normalizeAbsolutePath(targetPath);
  return resolveCanonicalPathSync({
    cursor: normalizedTarget,
    normalizedTarget,
    suffix: [],
  });
}

export async function createDescriptorCandidate(options: {
  config: ResolvedLiminaConfig;
  kind: WorkspaceDescriptorKind;
  ownerDirectory: string;
  path: string;
  rootDir: string;
}): Promise<WorkspaceDescriptorCandidate> {
  return {
    canonicalPath: normalizeAbsolutePath(await realpath(options.path)),
    displayPath: displayWorkspacePath(options.config.rootDir, options.path),
    kind: options.kind,
    ownerDirectory: options.ownerDirectory,
    path: normalizeAbsolutePath(options.path),
    rootDir: normalizeAbsolutePath(options.rootDir),
  };
}

export function isMissingFsError(error: unknown): boolean {
  return isMissingPathError(error);
}
