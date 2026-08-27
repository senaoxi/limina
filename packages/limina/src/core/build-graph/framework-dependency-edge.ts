import { formatImportRecordLocation } from '#core/import-graph/context';
import { toRelativePath } from '#utils/path';
import type { ReferenceImportContext } from './reference-import-types';
import type { GeneratedDependencyEdge, GovernedSourceUnit } from './types';

type FrameworkImportRecord = Parameters<typeof formatImportRecordLocation>[1];

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
