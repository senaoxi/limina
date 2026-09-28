import { readFileSync } from 'node:fs';
import type { PackageManifest } from './package-types';

export function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')) as T;
}

export function getManifestPackageName(
  manifest: PackageManifest,
): string | null {
  if (typeof manifest.name !== 'string') {
    return null;
  }

  const name = manifest.name.trim();
  return name.length === 0 ? null : name;
}
