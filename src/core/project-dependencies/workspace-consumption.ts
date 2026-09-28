import type { WorkspacePackage } from '#core/workspace/actions';
import type { WorkspaceLookupIndex } from '../workspace/lookup';
import type {
  ProjectDependency,
  ProjectDependencyObservation,
} from './contracts';
import { getDependencyCheckerTarget } from './evidence';

export type WorkspaceConsumption =
  | ProjectDependency
  | Exclude<ProjectDependencyObservation, { kind: 'unmapped-generated' }>;

export interface WorkspaceConsumptionFailure {
  consumption: WorkspaceConsumption;
  kind: 'unresolved' | 'missing-type-entry';
  package: WorkspacePackage & { name: string };
  resolvedFilePath: string | null;
}

function isSemanticOnly(consumption: WorkspaceConsumption): boolean {
  return 'kind' in consumption && consumption.kind === 'semantic-only';
}

function isUntypedExport(options: {
  resolvedFilePath: string;
  targetPackage: WorkspacePackage;
  workspaceLookup: WorkspaceLookupIndex;
}): boolean {
  if (options.targetPackage.manifest.exports === undefined) return false;
  return hasUntypedTarget(options);
}

function hasUntypedTarget(options: {
  resolvedFilePath: string;
  targetPackage: WorkspacePackage;
  workspaceLookup: WorkspaceLookupIndex;
}): boolean {
  if (!/\.(?:cjs|mjs|jsx|js)$/iu.test(options.resolvedFilePath)) return false;
  // A raw package name is not authority to reattribute a paths/alias target.
  return (
    options.workspaceLookup.findPackageForFile(options.resolvedFilePath)
      ?.directory === options.targetPackage.directory
  );
}

function ignoresConsumption(consumption: WorkspaceConsumption): boolean {
  return [
    isSemanticOnly(consumption),
    // TypeScript has no module-resolution occurrence for require.resolve.
    consumption.importRecord.kind === 'require-resolve',
    consumption.evidence.checker.kind === 'unobserved',
  ].some(Boolean);
}

export function getWorkspaceConsumptionFailure(options: {
  consumption: WorkspaceConsumption;
  workspaceLookup: WorkspaceLookupIndex;
}): WorkspaceConsumptionFailure | null {
  if (ignoresConsumption(options.consumption)) return null;
  const targetPackage = options.workspaceLookup.findPackageForSpecifier(
    options.consumption.importRecord.specifier,
  );
  if (targetPackage === null) return null;
  return getNamedConsumptionFailure({ ...options, targetPackage });
}

function getNamedConsumptionFailure(options: {
  consumption: WorkspaceConsumption;
  workspaceLookup: WorkspaceLookupIndex;
  targetPackage: WorkspacePackage;
}): WorkspaceConsumptionFailure | null {
  if (!options.targetPackage.name) return null;
  return classifyConsumption({
    ...options,
    targetPackage: {
      ...options.targetPackage,
      name: options.targetPackage.name,
    },
  });
}

function classifyConsumption(options: {
  consumption: WorkspaceConsumption;
  workspaceLookup: WorkspaceLookupIndex;
  targetPackage: WorkspacePackage & { name: string };
}): WorkspaceConsumptionFailure | null {
  const target = getDependencyCheckerTarget(options.consumption.evidence);
  const base = {
    consumption: options.consumption,
    package: options.targetPackage,
  };
  if (target === null)
    return { ...base, kind: 'unresolved', resolvedFilePath: null };
  return isUntypedExport({
    ...options,
    resolvedFilePath: target.resolvedFileName,
  })
    ? {
        ...base,
        kind: 'missing-type-entry',
        resolvedFilePath: target.resolvedFileName,
      }
    : null;
}

export function describeWorkspaceConsumptionFailure(
  failure: WorkspaceConsumptionFailure,
): string[] {
  const { consumption } = failure;
  const target = failure.resolvedFilePath ?? '(none)';
  return [
    `  file: ${consumption.importRecord.filePath}:${consumption.importRecord.line}`,
    `  imported specifier: ${consumption.importRecord.specifier}`,
    `  package: ${failure.package.name}`,
    `  importing project: ${consumption.evidence.context.configPath}`,
    `  resolution mode: ${consumption.resolutionMode}`,
    `  checker resolved file: ${target}`,
    `  resolution failure: ${failure.kind}`,
  ];
}
