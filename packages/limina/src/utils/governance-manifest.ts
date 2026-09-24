import { lstatSync, readFileSync, statSync } from 'node:fs';
import path from 'pathe';
import type { PackageManifest } from '../core/workspace/package-types';
import { ancestorDirectories } from './ancestor-directories';

export interface GovernanceRootBase {
  readonly rootDir: string;
  readonly manifestPath: string;
  readonly manifest: Readonly<PackageManifest>;
}

/** Detect the lexical entry, including dangling links. An invalid entry is not absence. */
export function hasManifestEntry(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function findNearestPackageManifest(startDir: string): string | null {
  for (const directory of ancestorDirectories(startDir)) {
    const candidate = path.join(directory, 'package.json');
    if (hasManifestEntry(candidate)) return candidate;
  }
  return null;
}

function freezeManifest<T>(value: T): T {
  if (!isObjectValue(value)) return value;
  for (const child of Object.values(value)) freezeManifest(child);
  Object.freeze(value);
  return value;
}

/** Root location and contents are one fact for this config-resolution generation. */
export function resolveGovernanceManifest(
  startDir: string,
): GovernanceRootBase {
  const manifestPath = findNearestPackageManifest(startDir);
  if (manifestPath === null)
    throw new Error(`No package.json found from ${startDir} or its ancestors.`);
  return readGovernanceManifest(manifestPath);
}

export function readGovernanceManifest(
  manifestPath: string,
): GovernanceRootBase {
  const manifest = freezeManifest(readWorkspaceRootManifest(manifestPath));
  return Object.freeze({
    rootDir: path.dirname(manifestPath),
    manifestPath,
    manifest,
  });
}

function isObjectValue(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

export function isManifestObject(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null) return false;
  return typeof value === 'object' && !Array.isArray(value);
}

export function readWorkspaceRootManifest(filePath: string): PackageManifest {
  const value: unknown = readRootManifestValue(filePath);
  if (!isManifestObject(value)) {
    throw new Error(`Invalid package.json object at ${filePath}.`);
  }
  return value as PackageManifest;
}

function readRootManifestValue(filePath: string): unknown {
  try {
    if (!statSync(filePath).isFile())
      throw new Error('Expected a regular file.');
    return JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, ''));
  } catch (error) {
    throw new Error(
      `Unable to read root package.json at ${filePath}: ${String(error)}`,
      { cause: error },
    );
  }
}
