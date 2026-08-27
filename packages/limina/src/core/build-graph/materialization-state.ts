import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'pathe';
import { performAtomicJsonWrite } from '../../check-reporting/atomic-write-operation';
import {
  type LiminaArtifactNamespace,
  resolveArtifactNamespaceRelativePath,
} from '../../domain/artifacts/namespace';
import { createMaterializationRevision } from '../../domain/artifacts/plan';
import type { MaterializationRevision } from '../../domain/shared/identifiers';
import type { CrossProcessLeaseOwner } from '../../utils/mutation/cross-process-lease';
import {
  isNonEmptyString,
  isPositiveInteger,
  isString,
  isStringArray,
  matchesRecordSchema,
} from '../../utils/validation/record-schema';
import { isOwnedArtifactLedgerVersion } from './manifest-version';

export const materializationMarkerRelativePath: string = path.join(
  '.state',
  'generated-artifacts',
  'in-progress.json',
);

export interface MaterializationInProgressMarker {
  version: 1;
  operationId: string;
  owner: CrossProcessLeaseOwner;
  baseRevision: MaterializationRevision;
  desiredRevision: MaterializationRevision;
  ownedPathUniverse: readonly string[];
  targetOwnedPaths: readonly string[];
}

export interface MaterializationStateSnapshot {
  ownedPaths: string[];
  revision: MaterializationRevision;
}

export class MaterializationRecoveryRequired extends Error {
  override readonly name = 'MaterializationRecoveryRequired';
}

export class CorruptMaterializationStateError extends Error {
  override readonly name = 'CorruptMaterializationStateError';
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export function getMaterializationMarkerPath(
  namespace: LiminaArtifactNamespace,
): string {
  return path.join(namespace.rootDir, materializationMarkerRelativePath);
}

function isLeaseOwner(value: unknown): value is CrossProcessLeaseOwner {
  return matchesRecordSchema(value, {
    hostname: isString,
    pid: isPositiveInteger,
    startedAt: isString,
    token: isNonEmptyString,
  });
}

function isMarker(value: unknown): value is MaterializationInProgressMarker {
  return matchesRecordSchema(value, {
    baseRevision: isNonEmptyString,
    desiredRevision: isNonEmptyString,
    operationId: isNonEmptyString,
    ownedPathUniverse: isStringArray,
    owner: isLeaseOwner,
    targetOwnedPaths: isStringArray,
    version: (version) => version === 1,
  });
}

function missingFileOrThrow(error: unknown): null {
  if (hasCode(error, 'ENOENT')) return null;
  throw error;
}

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    return missingFileOrThrow(error);
  }
}

function assertMarkerPaths(
  namespace: LiminaArtifactNamespace,
  marker: MaterializationInProgressMarker,
): void {
  const paths = [...marker.ownedPathUniverse, ...marker.targetOwnedPaths];
  for (const relativePath of paths) {
    resolveArtifactNamespaceRelativePath(namespace, relativePath);
  }
}

function parseMarker(
  namespace: LiminaArtifactNamespace,
  text: string,
): MaterializationInProgressMarker {
  const value: unknown = JSON.parse(text);
  if (!isMarker(value)) throw new Error('invalid marker shape');
  assertMarkerPaths(namespace, value);
  return value;
}

function corruptMarker(error: unknown): CorruptMaterializationStateError {
  return new CorruptMaterializationStateError(
    `Generated-artifact recovery marker is corrupt: ${String(error)}`,
  );
}

export async function readMaterializationMarker(
  namespace: LiminaArtifactNamespace,
): Promise<MaterializationInProgressMarker | null> {
  const markerPath = getMaterializationMarkerPath(namespace);
  const text = await readOptionalText(markerPath);
  if (text === null) return null;
  try {
    return parseMarker(namespace, text);
  } catch (error) {
    throw corruptMarker(error);
  }
}

export async function writeMaterializationMarker(options: {
  marker: MaterializationInProgressMarker;
  namespace: LiminaArtifactNamespace;
}): Promise<void> {
  await performAtomicJsonWrite({
    namespace: options.namespace,
    options: {},
    targetPath: getMaterializationMarkerPath(options.namespace),
    value: options.marker,
  });
}

export async function removeMaterializationMarker(
  namespace: LiminaArtifactNamespace,
): Promise<void> {
  await rm(getMaterializationMarkerPath(namespace), { force: false });
}

function isManifest(value: unknown): value is {
  generatedBy: 'limina';
  ownedArtifacts: string[];
  version: number;
} {
  return matchesRecordSchema(value, {
    generatedBy: (generatedBy) => generatedBy === 'limina',
    ownedArtifacts: isStringArray,
    version: isOwnedArtifactLedgerVersion,
  });
}

function parseManifest(text: string): string[] {
  const value: unknown = JSON.parse(text);
  if (!isManifest(value)) throw new Error('invalid manifest shape');
  return [...new Set(value.ownedArtifacts)].sort();
}

function corruptManifest(error: unknown): CorruptMaterializationStateError {
  return new CorruptMaterializationStateError(
    `Generated-artifact manifest is corrupt: ${String(error)}`,
  );
}

async function readManifestOwnedPaths(
  namespace: LiminaArtifactNamespace,
): Promise<string[]> {
  const manifestPath = path.join(namespace.rootDir, 'manifest.json');
  const text = await readOptionalText(manifestPath);
  if (text === null) return [];
  try {
    return parseManifest(text);
  } catch (error) {
    throw corruptManifest(error);
  }
}

async function readRevisionEntry(options: {
  namespace: LiminaArtifactNamespace;
  relativePath: string;
}) {
  const absolutePath = resolveArtifactNamespaceRelativePath(
    options.namespace,
    options.relativePath,
  );
  try {
    return {
      content: await readFile(absolutePath),
      path: options.relativePath,
    };
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return { content: null, path: options.relativePath };
    }
    throw error;
  }
}

export async function readMaterializationStateSnapshot(
  namespace: LiminaArtifactNamespace,
): Promise<MaterializationStateSnapshot> {
  const ownedPaths = await readManifestOwnedPaths(namespace);
  const entries = await Promise.all(
    ownedPaths.map((relativePath) =>
      readRevisionEntry({ namespace, relativePath }),
    ),
  );
  return {
    ownedPaths,
    revision: createMaterializationRevision(entries),
  };
}

export function createMaterializationMarker(options: {
  baseRevision: MaterializationRevision;
  desiredRevision: MaterializationRevision;
  oldMarker: MaterializationInProgressMarker | null;
  owner: CrossProcessLeaseOwner;
  planBaseOwnedPaths: readonly string[];
  planDeletePaths: readonly string[];
  currentOwnedPaths: readonly string[];
  targetOwnedPaths: readonly string[];
}): MaterializationInProgressMarker {
  const oldOwnedPaths =
    options.oldMarker === null
      ? []
      : [
          ...options.oldMarker.ownedPathUniverse,
          ...options.oldMarker.targetOwnedPaths,
        ];
  return {
    version: 1,
    operationId: randomUUID(),
    owner: {
      ...options.owner,
      hostname: hostname(),
      pid: process.pid,
    },
    baseRevision: options.baseRevision,
    desiredRevision: options.desiredRevision,
    ownedPathUniverse: [
      ...new Set([
        ...options.currentOwnedPaths,
        ...oldOwnedPaths,
        ...options.planBaseOwnedPaths,
        ...options.planDeletePaths,
        ...options.targetOwnedPaths,
      ]),
    ].sort(),
    targetOwnedPaths: [...new Set(options.targetOwnedPaths)].sort(),
  };
}
