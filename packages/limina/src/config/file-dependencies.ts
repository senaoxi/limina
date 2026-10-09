import { normalizeAbsolutePath } from '#utils/path';
import { realpathSync } from 'node:fs';
import path from 'pathe';
import { pathBinding } from '../core/analysis-cache/directory-fingerprint';
import { analysisHash } from '../core/analysis-cache/identity';
import type { ConfigLoadEvidence } from './load-evidence';

function physicalPath(file: string): string {
  try {
    return normalizeAbsolutePath(realpathSync.native(file));
  } catch (error) {
    if (
      ['ENOENT', 'ENOTDIR'].includes(
        String((error as NodeJS.ErrnoException).code),
      )
    )
      return file;
    throw error;
  }
}

/**
Registration begins after evaluation; it cannot attest to earlier fs reads.
*/
export function captureFileDependencies(
  evidence: ConfigLoadEvidence,
  configPath: string,
  dependencies: readonly string[] = [],
): void {
  for (const dependency of dependencies) {
    const file = normalizeAbsolutePath(
      path.resolve(path.dirname(configPath), dependency),
    );
    captureDependency(evidence, file);
  }
}
function assertBinding(
  evidence: ConfigLoadEvidence,
  entry: { file: string; binding: string },
): void {
  const previous = evidence.requestBindings.get(entry.file);
  if (previous !== undefined && previous !== entry.binding)
    throw new Error(
      `Limina configuration resolution binding changed during evaluation: ${entry.file}. Run the command again.`,
    );
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function captureFile(
  evidence: ConfigLoadEvidence,
  entry: { file: string; resolvedPath: string },
): void {
  try {
    evidence.capture(entry.resolvedPath, 'dependency');
  } catch (error) {
    throw new Error(
      `Cannot observe configDependencies file ${entry.file}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}
function captureDependency(evidence: ConfigLoadEvidence, file: string): void {
  if (evidence.dependencies.has(file)) return;
  const binding = analysisHash(pathBinding(file));
  assertBinding(evidence, { file, binding });
  const resolvedPath = physicalPath(file);
  captureFile(evidence, { file, resolvedPath });
  evidence.dependencies.set(file, { path: file, resolvedPath, binding });
  evidence.requestBindings.set(file, binding);
}
