import path from 'pathe';
import type { JsonObject } from './action-types';
import { isOrdinarySourceTypecheckConfigPath } from './config-paths';

export interface TsconfigSolutionRoleInput {
  configObject: JsonObject;
  configPath: string;
  fileNames: readonly string[];
}

/**
 * Mirrors TypeScript's stable semantic solution-config shape without using its
 * private implementation: a parsed project owns no source files and directly
 * declares the project-reference property.
 */
export function isTypeScriptSolutionConfig(
  input: TsconfigSolutionRoleInput,
): boolean {
  return (
    input.fileNames.length === 0 &&
    Object.hasOwn(input.configObject, 'references')
  );
}

/**
 * Limina supports TypeScript solution configs only at the default entry path.
 */
export function isLiminaSolutionConfig(
  input: TsconfigSolutionRoleInput,
): boolean {
  return (
    path.basename(input.configPath) === 'tsconfig.json' &&
    isTypeScriptSolutionConfig(input)
  );
}

/**
 * A named ordinary source config that has TypeScript's solution semantics is
 * reachable during migration but cannot be a Limina-managed solution entry.
 */
export function isUnsupportedNamedSolutionConfig(
  input: TsconfigSolutionRoleInput & { rootDir: string },
): boolean {
  return (
    isOrdinarySourceTypecheckConfigPath(input.configPath, input.rootDir) &&
    path.basename(input.configPath) !== 'tsconfig.json' &&
    isTypeScriptSolutionConfig(input)
  );
}
