import { normalizeAbsolutePath } from '#utils/path';
import { realpathSync } from 'node:fs';
import path from 'pathe';
import ts from 'typescript';
import type { TypeScriptSemanticProject } from '../typescript-semantic/contracts';
import { AnalysisInputDriftError, type InputDependency } from './contracts';
import { analysisHash } from './identity';
import { inputStat } from './input-state';
import type { AnalysisInputs } from './inputs';

export interface TypeEnvironmentRecord {
  policy: 'physical-type-roots-v1';
  effectiveTypeRoots: string[];
  typeRootsHash: string;
  dependencies: InputDependency[];
  evidence: 'observed' | 'unknown';
  reason?: string;
}

function typeRootInput(root: string, types: readonly string[] | undefined) {
  const physical = inputStat(root)?.isDirectory()
    ? normalizeAbsolutePath(realpathSync.native(root))
    : root;
  const isInstalled = [root, physical].some((file) =>
    file.split('/').includes('node_modules'),
  );
  if (!isInstalled) return 'tree';
  // Generated projects can also use node_modules itself as a lookup root for explicit type names.
  return types !== undefined &&
    path.basename(physical) === 'node_modules' &&
    !types.includes('*')
    ? 'directory-identity'
    : 'type-packages';
}

export function observeTypeEnvironment(
  project: TypeScriptSemanticProject,
  inputs: AnalysisInputs,
  options: { tsModule?: typeof ts } = {},
): TypeEnvironmentRecord {
  const compiler = options.tsModule ?? ts;
  const roots = (
    compiler.getEffectiveTypeRoots(project.options, {
      getCurrentDirectory: () => path.dirname(project.configPath),
    }) ?? []
  ).map(normalizeAbsolutePath);
  const dependencies: InputDependency[] = [];
  let reason: string | undefined;
  try {
    for (const root of roots) {
      dependencies.push(
        inputs.observe(root, typeRootInput(root, project.options.types)),
      );
    }
  } catch (error) {
    if (error instanceof AnalysisInputDriftError) throw error;
    reason = String(error);
  }
  return {
    policy: 'physical-type-roots-v1',
    effectiveTypeRoots: roots,
    typeRootsHash: analysisHash([
      project.options.typeRoots === undefined,
      roots,
      dependencies,
    ]),
    dependencies,
    evidence: reason === undefined ? 'observed' : 'unknown',
    ...(reason !== undefined && { reason }),
  };
}
