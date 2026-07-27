import {
  formatImportRecordLocation,
  type ImportRecord,
  type ProjectInfo,
} from '#core/import-graph/context';
import type { WorkspacePackage } from '#core/workspace/actions';
import { toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { WorkspacePackageExportResolution } from '../core/workspace/exports';
import { createGraphImportFact, getProjectCheckerName } from './finding-utils';
import type { GraphWorkspaceImportUnresolvedFinding } from './findings';
import { getResolvedPackageName } from './import-resolution-utils';
import type { ExpectedReferenceCollectionContext } from './reference-types';
import { getDeniedDepRuleForPackage, type GraphRuleDepDeny } from './rules';

function formatResolvedLine(
  label: string,
  filePath: string | null,
  rootDir: string,
): string {
  return filePath
    ? `  ${label}: ${toRelativePath(rootDir, filePath)}`
    : `  ${label}: (none)`;
}

function getExportDisplayName(
  resolution: WorkspacePackageExportResolution,
): string {
  return resolution.subpath === '.'
    ? resolution.packageName
    : `${resolution.packageName}${resolution.subpath.slice(1)}`;
}

function createResolvedFileFacts(resolvedFilePath: string | null): {
  resolvedFilePath?: string;
} {
  return resolvedFilePath ? { resolvedFilePath } : {};
}

export function addWorkspacePackageExportWithoutTypeEntryProblem(options: {
  context: ExpectedReferenceCollectionContext;
  importRecord: ImportRecord;
  project: ProjectInfo;
  resolution: WorkspacePackageExportResolution;
}): void {
  const typeScriptPath = options.resolution.typeScriptResolvedFileName;
  const runtimePath = options.resolution.oxcResolvedFileName;
  const resolvedFilePath = typeScriptPath ?? runtimePath;
  const reason =
    'governed source imports through package exports must resolve to a stable type or checker source entry.';
  const fix =
    'add a types/declaration branch for this export, import a typed public API, or keep this entry as a runtime-only resource outside governed source imports.';
  const detailLines = [
    'Workspace source import uses package export without a type entry:',
    `  importing project: ${toRelativePath(options.context.config.rootDir, options.project.configPath)}`,
    `  file: ${formatImportRecordLocation(options.context.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  package: ${options.resolution.packageName}`,
    `  export: ${options.resolution.subpath}`,
    formatResolvedLine(
      'TypeScript resolved file',
      typeScriptPath,
      options.context.config.rootDir,
    ),
    formatResolvedLine(
      'runtime resolved file',
      runtimePath,
      options.context.config.rootDir,
    ),
    `  reason: ${reason}`,
    `  fix: ${fix}`,
  ];

  options.context.findings.push({
    checkerName: getProjectCheckerName(
      options.context.projectCheckerNamesByPath,
      options.project.configPath,
    ),
    code: LIMINA_CHECK_ISSUE_CODES.graphWorkspaceImportUnresolved,
    evidence: [
      {
        label: 'import',
        lines: [
          `file: ${options.importRecord.filePath}`,
          `line: ${options.importRecord.line}`,
          `kind: ${options.importRecord.kind}`,
        ],
        value: options.importRecord.specifier,
      },
      {
        label: 'package export',
        value: getExportDisplayName(options.resolution),
      },
    ],
    facts: {
      import: createGraphImportFact(options.importRecord),
      importingProjectPath: options.project.configPath,
      kind: 'missing-type-entry',
      ...createResolvedFileFacts(resolvedFilePath),
      targetPackageName: options.resolution.packageName,
    },
    filePath: options.importRecord.filePath,
    locations: [
      {
        filePath: options.importRecord.filePath,
        label: 'import',
        line: options.importRecord.line,
      },
      { filePath: options.project.configPath, label: 'importing project' },
    ],
    packageName: options.resolution.packageName,
    presentation: {
      detailLines,
      fix,
      reason,
      title: 'Workspace source import uses package export without a type entry',
    },
    task: 'graph:check',
  } satisfies GraphWorkspaceImportUnresolvedFinding);
}

function getPackageName(packageInfo: WorkspacePackage | null): string | null {
  if (!packageInfo) {
    return null;
  }

  return packageInfo.name ?? null;
}

function hasWorkspaceExportTarget(options: {
  context: ExpectedReferenceCollectionContext;
  targetPackage: WorkspacePackage | null;
}): boolean {
  const packageName = getPackageName(options.targetPackage);
  if (!packageName) {
    return false;
  }

  return options.context.workspaceExports.hasExports(packageName);
}

export function getWorkspaceExportResolution(options: {
  context: ExpectedReferenceCollectionContext;
  importRecord: ImportRecord;
  project: ProjectInfo;
  targetPackage: WorkspacePackage | null;
}): WorkspacePackageExportResolution | null {
  if (!hasWorkspaceExportTarget(options)) {
    return null;
  }

  return options.context.workspaceExports.get(
    options.project.configPath,
    options.importRecord.specifier,
  );
}

function isSameNamedPackage(
  targetPackage: WorkspacePackage | null,
  resolvedPackage: WorkspacePackage | null,
): boolean {
  const targetName = getPackageName(targetPackage);
  if (!targetName) {
    return false;
  }

  return getPackageName(resolvedPackage) === targetName;
}

export function getTargetPackageForGraph(options: {
  targetPackage: WorkspacePackage | null;
  targetWorkspacePackageForResolved: WorkspacePackage | null;
  useWorkspaceExportResolution: boolean;
}): WorkspacePackage | null {
  if (options.useWorkspaceExportResolution) {
    return options.targetPackage;
  }

  return isSameNamedPackage(
    options.targetPackage,
    options.targetWorkspacePackageForResolved,
  )
    ? options.targetPackage
    : null;
}

export function getDeniedDepRuleForResolvedPackage(options: {
  context: ExpectedReferenceCollectionContext;
  project: ProjectInfo;
  resolvedFilePath: string;
}): GraphRuleDepDeny | null {
  const packageName = getResolvedPackageName(
    options.resolvedFilePath,
    options.context.workspaceLookup,
  );
  if (!packageName) {
    return null;
  }

  return getDeniedDepRuleForPackage(
    options.context.graphRules,
    options.project.labels,
    packageName,
  );
}
