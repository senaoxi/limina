import { toRelativePath } from '#utils/path';
import { formatUnknownValue, isPlainRecord } from '#utils/values';
import path from 'pathe';
import ts from 'typescript';
import type { MigrationEffectiveConfig } from './types';

export interface DeclarationDirPlan {
  movedOutputs: Record<string, unknown>;
  removeDeclarationDir: boolean;
}
export interface DeclarationDirPlanOptions {
  configPath: string;
  compilerOptions: Record<string, unknown>;
  directOutDir: unknown;
  effectiveConfig: MigrationEffectiveConfig;
  existingOutputs: Record<string, unknown> | undefined;
  isLiminaSolution: boolean;
  movedOutputs: Record<string, unknown>;
  rootDir: string;
}
interface DeclarationDirPaths {
  declarationDirAbsolute: string;
  effectiveOutDirAbsolute: string | undefined;
  plannedManagedRootAbsolute: string | undefined;
}
function formatDiagnosticValue(value: unknown): string {
  return value === undefined ? '(none)' : formatUnknownValue(value);
}
function createDeclarationDirDiagnostic(options: {
  configPath: string;
  directDeclarationDir: unknown;
  directOutDir: unknown;
  effectiveOutDir: unknown;
  effectiveOutFile?: unknown;
  existingOutputsOutDir: unknown;
  plannedManagedRoot: unknown;
  reason: string;
  rootDir: string;
  fix: string;
}): Error {
  return new Error(
    [
      'Unable to migrate compilerOptions.declarationDir:',
      `  config: ${toRelativePath(options.rootDir, options.configPath)}`,
      `  direct compilerOptions.declarationDir: ${formatDiagnosticValue(options.directDeclarationDir)}`,
      `  effective compilerOptions.outDir: ${formatDiagnosticValue(options.effectiveOutDir)}`,
      `  direct compilerOptions.outDir: ${formatDiagnosticValue(options.directOutDir)}`,
      `  existing liminaOptions.outputs.outDir: ${formatDiagnosticValue(options.existingOutputsOutDir)}`,
      `  planned managed output root: ${formatDiagnosticValue(options.plannedManagedRoot)}`,
      ...(options.effectiveOutFile === undefined
        ? []
        : [
            `  effective compilerOptions.outFile: ${formatDiagnosticValue(options.effectiveOutFile)}`,
          ]),
      `  reason: ${options.reason}`,
      `  fix: ${options.fix}`,
    ].join('\n'),
  );
}
function throwDeclarationDirDiagnostic(options: {
  context: DeclarationDirPlanOptions;
  directDeclarationDir: unknown;
  plannedManagedRoot: unknown;
  reason: string;
  fix: string;
}): never {
  throw createDeclarationDirDiagnostic({
    configPath: options.context.configPath,
    directDeclarationDir: options.directDeclarationDir,
    directOutDir: options.context.directOutDir,
    effectiveOutDir: options.context.effectiveConfig.options.outDir,
    effectiveOutFile: options.context.effectiveConfig.options.outFile,
    existingOutputsOutDir: options.context.existingOutputs?.outDir,
    plannedManagedRoot: options.plannedManagedRoot,
    reason: options.reason,
    rootDir: options.context.rootDir,
    fix: options.fix,
  });
}
function hasDirectDeclarationDir(
  compilerOptions: Record<string, unknown>,
): boolean {
  return Object.hasOwn(compilerOptions, 'declarationDir');
}
function requireDirectDeclarationDir(
  options: DeclarationDirPlanOptions,
): string {
  const value = options.compilerOptions.declarationDir;
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  return throwDeclarationDirDiagnostic({
    context: options,
    directDeclarationDir: value,
    plannedManagedRoot: undefined,
    reason: 'direct compilerOptions.declarationDir must be a non-empty string.',
    fix: 'set declarationDir to a non-empty path or remove the field before running migration.',
  });
}
function assertNoEffectiveOutFile(
  options: DeclarationDirPlanOptions,
  directDeclarationDir: string,
): void {
  if (options.effectiveConfig.options.outFile === undefined) return;
  throwDeclarationDirDiagnostic({
    context: options,
    directDeclarationDir,
    plannedManagedRoot: undefined,
    reason:
      'compilerOptions.outFile is effective together with declarationDir, so the config cannot be represented by Limina managed outputs.',
    fix: 'remove outFile or migrate this config outside the Limina managed artifact model.',
  });
}
function planSolutionDeclarationDir(
  options: DeclarationDirPlanOptions,
  directDeclarationDir: string,
): DeclarationDirPlan {
  if (options.effectiveConfig.fileNames.length > 0) {
    throwDeclarationDirDiagnostic({
      context: options,
      directDeclarationDir,
      plannedManagedRoot: undefined,
      reason:
        'a Limina solution config owns effective source files, which violates the internal solution-role invariant.',
      fix: 'move source inputs to an ordinary leaf config and keep the solution config source-free.',
    });
  }
  return { movedOutputs: options.movedOutputs, removeDeclarationDir: true };
}
function stripTrailingSeparators(value: string): string {
  return value.replace(/[\\/]+$/u, '');
}
function preservePathRoot(value: string): string {
  if (value.length === 1 || /^[A-Za-z]:[\\/]$/u.test(value)) return value;
  return stripTrailingSeparators(value);
}
function applyFileSystemCase(value: string): string {
  return ts.sys.useCaseSensitiveFileNames ? value : value.toLowerCase();
}
function normalizeComparablePath(value: string): string {
  return applyFileSystemCase(preservePathRoot(path.normalize(value)));
}
function areEquivalentPaths(left: string, right: string): boolean {
  return normalizeComparablePath(left) === normalizeComparablePath(right);
}
function resolveConfigPath(configPath: string, value: string): string {
  return path.resolve(path.dirname(configPath), value);
}
function resolveOptionalConfigPath(
  configPath: string,
  value: unknown,
): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? resolveConfigPath(configPath, value)
    : undefined;
}
function hasPlannedOutputs(options: DeclarationDirPlanOptions): boolean {
  return (
    options.existingOutputs !== undefined ||
    Object.keys(options.movedOutputs).length > 0
  );
}
function computePlannedManagedRoot(
  options: DeclarationDirPlanOptions,
): unknown {
  const fallback = hasPlannedOutputs(options) ? './dist' : undefined;
  return [options.directOutDir, options.existingOutputs?.outDir, fallback].find(
    (value) => value !== undefined,
  );
}
function resolveDeclarationDirPaths(
  options: DeclarationDirPlanOptions,
  directDeclarationDir: string,
): DeclarationDirPaths {
  const plannedManagedRoot = computePlannedManagedRoot(options);
  return {
    declarationDirAbsolute: resolveConfigPath(
      options.configPath,
      directDeclarationDir,
    ),
    effectiveOutDirAbsolute: resolveOptionalConfigPath(
      options.configPath,
      options.effectiveConfig.options.outDir,
    ),
    plannedManagedRootAbsolute: resolveOptionalConfigPath(
      options.configPath,
      plannedManagedRoot,
    ),
  };
}
function assertEquivalentEffectiveOutDir(
  options: DeclarationDirPlanOptions,
  directDeclarationDir: string,
  paths: DeclarationDirPaths,
): void {
  if (
    paths.effectiveOutDirAbsolute === undefined ||
    areEquivalentPaths(
      paths.effectiveOutDirAbsolute,
      paths.declarationDirAbsolute,
    )
  ) {
    return;
  }
  throwDeclarationDirDiagnostic({
    context: options,
    directDeclarationDir,
    plannedManagedRoot: paths.plannedManagedRootAbsolute,
    reason:
      'Limina currently supports only one managed artifact output root and cannot express separate JavaScript and declaration output directories.',
    fix: 'make declarationDir equivalent to the managed output root, remove it, or choose one relative managed output path.',
  });
}
function assertEquivalentPlannedRoot(
  options: DeclarationDirPlanOptions,
  directDeclarationDir: string,
  paths: DeclarationDirPaths,
): void {
  if (
    paths.plannedManagedRootAbsolute === undefined ||
    areEquivalentPaths(
      paths.plannedManagedRootAbsolute,
      paths.declarationDirAbsolute,
    )
  ) {
    return;
  }
  throwDeclarationDirDiagnostic({
    context: options,
    directDeclarationDir,
    plannedManagedRoot: paths.plannedManagedRootAbsolute,
    reason:
      'Limina currently supports only one managed artifact output root and cannot express separate JavaScript and declaration output directories.',
    fix: 'make declarationDir equivalent to the managed output root, remove it, or choose one relative managed output path.',
  });
}
function assertAbsoluteDeclarationDir(
  options: DeclarationDirPlanOptions,
  directDeclarationDir: string,
): void {
  if (!path.isAbsolute(directDeclarationDir)) return;
  throwDeclarationDirDiagnostic({
    context: options,
    directDeclarationDir,
    plannedManagedRoot: undefined,
    reason:
      'an absolute declarationDir has no planned managed output root that Limina can safely adopt.',
    fix: 'choose a relative managed output path from this source tsconfig before running migration.',
  });
}
function planLeafWithResolvedPaths(
  options: DeclarationDirPlanOptions,
  directDeclarationDir: string,
  paths: DeclarationDirPaths,
): DeclarationDirPlan {
  if (paths.plannedManagedRootAbsolute !== undefined) {
    return { movedOutputs: options.movedOutputs, removeDeclarationDir: true };
  }
  assertAbsoluteDeclarationDir(options, directDeclarationDir);
  return {
    movedOutputs: { ...options.movedOutputs, outDir: directDeclarationDir },
    removeDeclarationDir: true,
  };
}
function planLeafDeclarationDir(
  options: DeclarationDirPlanOptions,
  directDeclarationDir: string,
): DeclarationDirPlan {
  const paths = resolveDeclarationDirPaths(options, directDeclarationDir);
  assertEquivalentEffectiveOutDir(options, directDeclarationDir, paths);
  assertEquivalentPlannedRoot(options, directDeclarationDir, paths);
  return planLeafWithResolvedPaths(options, directDeclarationDir, paths);
}
export function planDeclarationDir(
  options: DeclarationDirPlanOptions,
): DeclarationDirPlan {
  if (!hasDirectDeclarationDir(options.compilerOptions)) {
    return { movedOutputs: options.movedOutputs, removeDeclarationDir: false };
  }
  const directDeclarationDir = requireDirectDeclarationDir(options);
  assertNoEffectiveOutFile(options, directDeclarationDir);
  return options.isLiminaSolution
    ? planSolutionDeclarationDir(options, directDeclarationDir)
    : planLeafDeclarationDir(options, directDeclarationDir);
}
export function readExistingOutputOptions(
  tsconfig: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const liminaOptions = tsconfig.liminaOptions;
  if (!isPlainRecord(liminaOptions)) return undefined;
  const outputs = liminaOptions.outputs;
  return isPlainRecord(outputs) ? { ...outputs } : undefined;
}
