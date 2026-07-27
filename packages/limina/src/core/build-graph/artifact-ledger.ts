import { lstat, readFile } from 'node:fs/promises';
import {
  type LiminaArtifactNamespace,
  resolveArtifactNamespaceRelativePath,
  toArtifactNamespaceRelativePath,
} from '../../domain/artifacts/namespace';
import type { GeneratedGraphWriteContext } from './types';

function isMissingFileError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return 'code' in error && error.code === 'ENOENT';
}

function isUnreadableManifestError(error: unknown): boolean {
  return error instanceof SyntaxError || isMissingFileError(error);
}

async function readManifestValue(manifestPath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (isUnreadableManifestError(error)) {
      return null;
    }
    throw error;
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasManifestIdentity(value: Record<string, unknown>): boolean {
  return value.version === 3 && value.generatedBy === 'limina';
}

function getOwnedArtifactValue(value: unknown): unknown {
  if (!isObjectRecord(value)) {
    return null;
  }
  return hasManifestIdentity(value) ? value.ownedArtifacts : null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.every((entry) => typeof entry === 'string') ? value : null;
}

function getOwnedArtifacts(value: unknown): string[] | null {
  return asStringArray(getOwnedArtifactValue(value));
}

export async function readPreviousOwnedArtifactPaths(options: {
  artifactNamespace: LiminaArtifactNamespace;
  manifestPath: string;
}): Promise<string[]> {
  const value = await readManifestValue(options.manifestPath);
  const ownedArtifacts = getOwnedArtifacts(value);
  if (!ownedArtifacts) {
    return [];
  }
  return ownedArtifacts.map((relativePath) =>
    resolveArtifactNamespaceRelativePath(
      options.artifactNamespace,
      relativePath,
    ),
  );
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

async function addStaleArtifact(options: {
  context: GeneratedGraphWriteContext;
  filePath: string;
}): Promise<void> {
  if (options.context.expectedFiles.has(options.filePath)) {
    return;
  }
  if (!(await fileExists(options.filePath))) {
    return;
  }
  options.context.changes.push({
    path: options.filePath,
    status: 'delete',
  });
  options.context.changed = true;
}

export async function removeStaleGeneratedFiles(options: {
  context: GeneratedGraphWriteContext;
  previousOwnedPaths: readonly string[];
}): Promise<void> {
  for (const filePath of options.previousOwnedPaths) {
    await addStaleArtifact({ context: options.context, filePath });
  }
}

export function createOwnedArtifactLedger(options: {
  artifactNamespace: LiminaArtifactNamespace;
  expectedFiles: ReadonlySet<string>;
  manifestPath: string;
}): string[] {
  return [...options.expectedFiles, options.manifestPath]
    .map((filePath) =>
      toArtifactNamespaceRelativePath(options.artifactNamespace, filePath),
    )
    .sort();
}
