import { readAnalysisInput } from '#utils/analysis-input';
import { readFileSync } from 'node:fs';
import type { PackageManifest } from './package-types';

export function readJsonFile<T>(filePath: string): T {
  return JSON.parse(
    readAnalysisInput(filePath, () => readFileSync(filePath, 'utf8')).replace(
      /^\u{FEFF}/u,
      '',
    ),
  ) as T;
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
