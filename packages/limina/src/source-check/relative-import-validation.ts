import type { ResolvedLiminaConfig } from '#config/runner';
import type { ImportRecord } from '#core/import-graph/context';
import type { PackageOwner } from '#core/workspace/actions';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import type { SourceFinding } from './findings';
import { addRelativeImportOwnerProblem } from './import-boundary-findings';

function hasSamePackageScope(options: {
  filePath: string;
  resolvedFilePath: string;
  workspaceLookup: WorkspaceLookupIndex;
}): boolean {
  const sourceScope = options.workspaceLookup.findNearestPackageScopeInfo(
    options.filePath,
  );
  const targetScope = options.workspaceLookup.findNearestPackageScopeInfo(
    options.resolvedFilePath,
  );

  return sourceScope?.packageJsonPath === targetScope?.packageJsonPath;
}

export function addRelativeImportProblems(options: {
  config: ResolvedLiminaConfig;
  filePath: string;
  findings: SourceFinding[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  resolvedFilePath: string | null;
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  if (
    !options.config.source?.forbidCrossPackageRelativeImports ||
    !options.resolvedFilePath
  ) {
    return;
  }

  const context = { ...options, resolvedFilePath: options.resolvedFilePath };
  if (hasSamePackageScope(context)) {
    return;
  }

  addRelativeImportOwnerProblem({
    config: context.config,
    findings: context.findings,
    importRecord: context.importRecord,
    owner: context.owner,
    resolvedFilePath: context.resolvedFilePath,
    sourcePackageScope: context.workspaceLookup.findNearestPackageScopeInfo(
      context.filePath,
    ),
    targetPackageScope: context.workspaceLookup.findNearestPackageScopeInfo(
      context.resolvedFilePath,
    ),
  });
}
