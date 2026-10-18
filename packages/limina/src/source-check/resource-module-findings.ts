import type { ResolvedLiminaConfig } from '#config/runner';
import type { AnalysisProviderSet } from '#core';
import {
  formatImportRecordLocation,
  type ImportRecord,
  type ProjectInfo,
} from '#core/import-graph/context';
import type { PackageOwner } from '#core/workspace/actions';
import { toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { SourceResourceTypeEvidenceKind } from './finding-facts';
import { createSourceDiagnosticFinding } from './finding-utilities';
import type { SourceFinding } from './findings';
import type { ResourceResolver } from './resource-resolver';

interface ResourceModuleOptions {
  checkerName: string;
  config: ResolvedLiminaConfig;
  findings: SourceFinding[];
  importRecord: ImportRecord;
  resolutionMode: string;
  resourceResolver: ResourceResolver;
  owner: PackageOwner;
  project: ProjectInfo;
  typeEvidence: AnalysisProviderSet['typeEvidence'];
}

const NON_PHYSICAL_RUNTIME_KINDS = new Set(['asserted-virtual', 'unsupported']);

function isResourceImport(options: ResourceModuleOptions): boolean {
  const runtimeEvidence = options.typeEvidence.classifyImportRuntime({
    checkerName: options.checkerName,
    importRecord: options.importRecord,
    project: options.project,
    resolutionMode: 'checker-only',
  });
  return (
    runtimeEvidence.classification === 'resource' &&
    !NON_PHYSICAL_RUNTIME_KINDS.has(runtimeEvidence.runtime.kind)
  );
}

function addMissingResourceFinding(options: {
  base: ResourceModuleOptions;
  checkedPath: string | undefined;
  typeEvidenceKind: SourceResourceTypeEvidenceKind;
}): void {
  const title = 'Resource module was not found';
  const lines = [
    `${title}:`,
    `  import: ${formatImportRecordLocation(options.base.config.rootDir, options.base.importRecord)}`,
    `  specifier: ${options.base.importRecord.specifier}`,
    `  checker: ${options.base.checkerName}`,
    ...(options.checkedPath
      ? [
          `  checked path: ${toRelativePath(options.base.config.rootDir, options.checkedPath)}`,
        ]
      : []),
    `  type evidence: ${options.typeEvidenceKind}`,
  ];

  options.base.findings.push(
    createSourceDiagnosticFinding({
      checkerName: options.base.checkerName,
      code: LIMINA_CHECK_ISSUE_CODES.sourceResourceModuleNotFound,
      facts: {
        checkedPath: options.checkedPath,
        checkerName: options.base.checkerName,
        configPath: options.base.project.configPath,
        importerPath: options.base.importRecord.filePath,
        kind: 'resource-module-not-found',
        line: options.base.importRecord.line,
        specifier: options.base.importRecord.specifier,
        typeEvidenceKind: options.typeEvidenceKind,
      },
      filePath: options.base.importRecord.filePath,
      fix: 'Create the referenced resource at the resolved path or correct the import specifier.',
      lines,
      locations: [
        {
          filePath: options.base.importRecord.filePath,
          label: 'import',
          line: options.base.importRecord.line,
        },
      ],
      ownerName: options.base.owner.name,
      packageJsonPath: options.base.owner.packageJsonPath,
      reason:
        'Ambient or concrete type evidence cannot establish that a physical resource exists at runtime.',
      title,
    }),
  );
}

export function addResourceModuleProblems(
  options: ResourceModuleOptions,
): void {
  if (!isResourceImport(options)) return;
  const runtime = options.resourceResolver.resolve({
    importRecord: options.importRecord,
    options: options.project.options,
    resolutionMode: options.resolutionMode,
  });
  if (runtime.kind === 'missing')
    addMissingResourceFinding({
      base: options,
      checkedPath: runtime.checkedPath,
      typeEvidenceKind: 'unobserved',
    });
}
