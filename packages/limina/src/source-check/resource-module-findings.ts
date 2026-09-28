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
import { createSourceDiagnosticFinding } from './finding-utils';
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
  if (runtimeEvidence.classification !== 'resource') {
    return false;
  }
  if (NON_PHYSICAL_RUNTIME_KINDS.has(runtimeEvidence.runtime.kind)) {
    return false;
  }
  return true;
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

function addUndeclaredResourceFinding(options: {
  base: ResourceModuleOptions;
  runtimeAuthority: 'filesystem' | 'oxc' | 'package-export';
  runtimeFilePath: string;
  typeEvidenceKind: 'missing';
}): void {
  const title = 'Resource module type is undeclared';

  options.base.findings.push(
    createSourceDiagnosticFinding({
      checkerName: options.base.checkerName,
      code: LIMINA_CHECK_ISSUE_CODES.sourceResourceModuleTypeUndeclared,
      facts: {
        checkerName: options.base.checkerName,
        configPath: options.base.project.configPath,
        importerPath: options.base.importRecord.filePath,
        kind: 'resource-module-type-undeclared',
        line: options.base.importRecord.line,
        runtimeAuthority: options.runtimeAuthority,
        runtimeFilePath: options.runtimeFilePath,
        specifier: options.base.importRecord.specifier,
        typeEvidenceKind: options.typeEvidenceKind,
      },
      filePath: options.base.importRecord.filePath,
      fix: 'Add a concrete declaration companion or an ambient module declaration included by this checker project.',
      lines: [
        `${title}:`,
        `  import: ${formatImportRecordLocation(options.base.config.rootDir, options.base.importRecord)}`,
        `  specifier: ${options.base.importRecord.specifier}`,
        `  checker: ${options.base.checkerName}`,
        `  runtime file: ${toRelativePath(options.base.config.rootDir, options.runtimeFilePath)}`,
      ],
      locations: [
        {
          filePath: options.base.importRecord.filePath,
          label: 'import',
          line: options.base.importRecord.line,
        },
        { filePath: options.runtimeFilePath, label: 'resource' },
      ],
      ownerName: options.base.owner.name,
      packageJsonPath: options.base.owner.packageJsonPath,
      reason:
        'The resource exists, but the current checker project has no concrete or ambient declaration for the import.',
      title,
    }),
  );
}

type ResourceImportEvidence = ReturnType<
  ResourceModuleOptions['typeEvidence']['resolveImportEvidence']
>;

type MissingRuntimeResourceEvidence = ResourceImportEvidence & {
  runtime: Extract<ResourceImportEvidence['runtime'], { kind: 'missing' }>;
};

type UndeclaredResourceTypeEvidence = ResourceImportEvidence & {
  runtime: Extract<ResourceImportEvidence['runtime'], { kind: 'file' }>;
  type: Extract<ResourceImportEvidence['type'], { kind: 'missing' }>;
};

function isMissingRuntimeResource(
  evidence: ResourceImportEvidence,
): evidence is MissingRuntimeResourceEvidence {
  return evidence.runtime.kind === 'missing';
}

function hasUndeclaredResourceType(
  evidence: ResourceImportEvidence,
): evidence is UndeclaredResourceTypeEvidence {
  return evidence.runtime.kind === 'file' && evidence.type.kind === 'missing';
}

function addResolvedResourceProblem(
  options: ResourceModuleOptions,
  evidence: ResourceImportEvidence,
): void {
  if (isMissingRuntimeResource(evidence)) {
    addMissingResourceFinding({
      base: options,
      checkedPath: evidence.runtime.checkedPath,
      typeEvidenceKind: evidence.type.kind,
    });
    return;
  }

  addExistingResourceProblem(options, evidence);
}

function addExistingResourceProblem(
  options: ResourceModuleOptions,
  evidence: ResourceImportEvidence,
): void {
  if (options.importRecord.kind === 'require-resolve') {
    return;
  }

  if (!hasUndeclaredResourceType(evidence)) {
    return;
  }

  addUndeclaredResourceFinding({
    base: options,
    runtimeAuthority: evidence.runtime.authority,
    runtimeFilePath: evidence.runtime.filePath,
    typeEvidenceKind: evidence.type.kind,
  });
}

export function addResourceModuleProblems(
  options: ResourceModuleOptions,
): void {
  if (!isResourceImport(options)) {
    return;
  }

  const evidence = options.typeEvidence.resolveImportEvidence({
    checkerName: options.checkerName,
    importRecord: options.importRecord,
    project: options.project,
    resolutionMode: 'checker-only',
  });
  if (evidence.type.kind === 'checker-source') return;
  addResolvedResourceProblem(options, {
    ...evidence,
    runtime: options.resourceResolver.resolve({
      importRecord: options.importRecord,
      options: options.project.options,
      resolutionMode: options.resolutionMode,
    }),
  });
}
