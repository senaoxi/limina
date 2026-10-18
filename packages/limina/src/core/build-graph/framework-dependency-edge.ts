import { formatImportRecordLocation } from '#core/import-graph/context';
import { toRelativePath } from '#utils/path';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import type { ProjectDependency } from '../project-dependencies/contracts';
import { getDependencyCheckerTarget } from '../project-dependencies/evidence';
import type { ReferenceImportContext } from './reference-import-types';
import type { GeneratedDependencyEdge, GovernedSourceUnit } from './types';

type FrameworkImportRecord = Parameters<typeof formatImportRecordLocation>[1];

export function hasFrameworkCompilationRequirement(
  dependency: ProjectDependency,
): boolean {
  return [
    dependency.targetKind === 'source',
    [
      dependency.referenceRequirement?.kind === 'source-semantic',
      hasFrameworkMembershipRequirement(dependency),
    ].some(Boolean),
  ].every(Boolean);
}

function hasFrameworkMembershipRequirement(
  dependency: ProjectDependency,
): boolean {
  // A framework resolver's component target still needs its owning checker
  // even when a wildcard ambient declaration supplies the current types.
  return [
    dependency.referenceRequirement?.kind === 'compiler-membership',
    getDependencyCheckerTarget(dependency.evidence)?.resolvedBy ===
      'checker-source',
  ].every(Boolean);
}

export function createFrameworkDependencyEdge(options: {
  context: ReferenceImportContext;
  importRecord: FrameworkImportRecord;
  resolvedFilePath: string;
  source: GovernedSourceUnit;
  targetCheckerName: string;
  targetConfigPath: string;
}): GeneratedDependencyEdge {
  return {
    file: formatImportRecordLocation(
      options.context.config.rootDir,
      options.importRecord,
    ),
    fromChecker: options.source.primaryCheckerName,
    fromConfigPath: options.source.configPath,
    importedSpecifier: options.importRecord.specifier,
    kind: 'framework-schedule',
    resolvedFilePath: options.resolvedFilePath,
    toChecker: options.targetCheckerName,
    toConfigPath: options.targetConfigPath,
  };
}

export function recordFrameworkDependencyEdge(
  context: ReferenceImportContext,
  edge: GeneratedDependencyEdge,
): void {
  if (isDeclarationFile(edge.resolvedFilePath))
    throw new Error(
      'Framework scheduling requires a source implementation target.',
    );
  const key = JSON.stringify([
    edge.fromChecker,
    edge.fromConfigPath,
    edge.toChecker,
    edge.toConfigPath,
    edge.file,
    edge.importedSpecifier,
    edge.resolvedFilePath,
  ]);
  context.dependencyEdgesByKey.set(key, edge);
}

export function addMissingFrameworkBuildOwnerProblem(options: {
  context: ReferenceImportContext;
  importRecord: FrameworkImportRecord;
  source: GovernedSourceUnit;
  targetConfigPath: string;
}): void {
  options.context.problems.push(
    [
      'Unable to schedule framework source dependency:',
      `  importing config: ${toRelativePath(options.context.config.rootDir, options.source.configPath)}`,
      `  file: ${formatImportRecordLocation(options.context.config.rootDir, options.importRecord)}`,
      `  target config: ${toRelativePath(options.context.config.rootDir, options.targetConfigPath)}`,
      '  reason: the imported governed source has no primary TypeScript build projection.',
    ].join('\n'),
  );
}

export function addAmbiguousFrameworkSourceOwnerProblem(options: {
  context: ReferenceImportContext;
  importRecord: FrameworkImportRecord;
  ownerConfigPaths: readonly string[];
  resolvedFilePath: string;
  source: GovernedSourceUnit;
}): void {
  options.context.problems.push(
    [
      'Ambiguous governed source ownership:',
      `  importing config: ${toRelativePath(options.context.config.rootDir, options.source.configPath)}`,
      `  file: ${formatImportRecordLocation(options.context.config.rootDir, options.importRecord)}`,
      `  resolved file: ${toRelativePath(options.context.config.rootDir, options.resolvedFilePath)}`,
      '  actual owning configs:',
      ...options.ownerConfigPaths.map(
        (configPath) =>
          `    - ${toRelativePath(options.context.config.rootDir, configPath)}`,
      ),
      '  reason: execution scheduling requires one actual governed source membership.',
    ].join('\n'),
  );
}
