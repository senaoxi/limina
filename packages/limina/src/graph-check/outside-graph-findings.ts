import {
  formatArtifactDependencyPolicy,
  formatImportRecordLocation,
  shouldResolveThroughGraph,
} from '#core/import-graph/context';
import { formatReferences } from '#core/tsconfig/actions';
import type { WorkspacePackage } from '#core/workspace/actions';
import { toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import { createGraphImportFact, getProjectCheckerName } from './finding-utils';
import type {
  GraphImportTargetUnmappedFinding,
  GraphWorkspaceImportOutsideGraphFinding,
} from './findings';
import type { ImportTargetOptions } from './import-target-types';

const GRAPH_CHECK_DEFAULT_REASON =
  'Graph check found architecture, dependency, resolver, or config violations.';

function addMappedWorkspaceImportProblem(options: ImportTargetOptions): void {
  const targetPackageName = options.resolution.targetPackageForGraph?.name;
  if (!targetPackageName) {
    return;
  }

  const detailLines = [
    'Unable to map workspace import to a graph project:',
    `  importing project: ${toRelativePath(options.context.config.rootDir, options.project.configPath)}`,
    `  file: ${formatImportRecordLocation(options.context.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  resolved file: ${toRelativePath(options.context.config.rootDir, options.resolution.graphResolvedFilePath)}`,
    `  current references: ${formatReferences(options.context.config.rootDir, options.project.references)}`,
  ];

  options.context.findings.push({
    checkerName: getProjectCheckerName(
      options.context.projectCheckerNamesByPath,
      options.project.configPath,
    ),
    code: LIMINA_CHECK_ISSUE_CODES.graphImportTargetUnmapped,
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
        label: 'resolved file',
        value: options.resolution.graphResolvedFilePath,
      },
    ],
    facts: {
      import: createGraphImportFact(options.importRecord),
      importingProjectPath: options.project.configPath,
      resolvedFilePath: options.resolution.graphResolvedFilePath,
      targetPackageName,
    },
    filePath: options.importRecord.filePath,
    locations: [
      {
        filePath: options.importRecord.filePath,
        label: 'import',
        line: options.importRecord.line,
      },
      { filePath: options.project.configPath, label: 'importing project' },
      {
        filePath: options.resolution.graphResolvedFilePath,
        label: 'resolved file',
      },
    ],
    packageName: targetPackageName,
    presentation: {
      detailLines,
      reason: GRAPH_CHECK_DEFAULT_REASON,
      title: 'Unable to map workspace import to a graph project',
    },
    task: 'graph:check',
  } satisfies GraphImportTargetUnmappedFinding);
}

function getGraphTargetPackage(
  options: ImportTargetOptions,
): WorkspacePackage | null {
  const targetPackage = options.resolution.targetPackageForGraph;
  if (!targetPackage) {
    return null;
  }

  return shouldResolveThroughGraph(options.resolution.importer, targetPackage)
    ? targetPackage
    : null;
}

function getPackageName(packageInfo: WorkspacePackage): string | null {
  return typeof packageInfo.name === 'string' && packageInfo.name.length > 0
    ? packageInfo.name
    : null;
}

function createOutsideGraphFinding(options: {
  importOptions: ImportTargetOptions;
  packageName: string;
  targetPackage: WorkspacePackage;
}): GraphWorkspaceImportOutsideGraphFinding {
  const reason = `source dependency edges must resolve to files owned by the source graph; ${formatArtifactDependencyPolicy(options.targetPackage)}`;
  const detailLines = [
    'Workspace source import resolved outside the workspace graph:',
    `  importing project: ${toRelativePath(options.importOptions.context.config.rootDir, options.importOptions.project.configPath)}`,
    `  file: ${formatImportRecordLocation(options.importOptions.context.config.rootDir, options.importOptions.importRecord)}`,
    `  imported specifier: ${options.importOptions.importRecord.specifier}`,
    `  resolved file: ${toRelativePath(options.importOptions.context.config.rootDir, options.importOptions.resolution.graphResolvedFilePath)}`,
    `  reason: ${reason}`,
  ];

  return {
    checkerName: getProjectCheckerName(
      options.importOptions.context.projectCheckerNamesByPath,
      options.importOptions.project.configPath,
    ),
    code: LIMINA_CHECK_ISSUE_CODES.graphWorkspaceImportOutsideGraph,
    evidence: [
      {
        label: 'import',
        lines: [
          `file: ${options.importOptions.importRecord.filePath}`,
          `line: ${options.importOptions.importRecord.line}`,
          `kind: ${options.importOptions.importRecord.kind}`,
        ],
        value: options.importOptions.importRecord.specifier,
      },
      {
        label: 'resolved file',
        value: options.importOptions.resolution.graphResolvedFilePath,
      },
    ],
    facts: {
      import: createGraphImportFact(options.importOptions.importRecord),
      importingProjectPath: options.importOptions.project.configPath,
      kind: 'outside-workspace-graph',
      resolvedFilePath: options.importOptions.resolution.graphResolvedFilePath,
      targetPackageName: options.packageName,
    },
    filePath: options.importOptions.importRecord.filePath,
    locations: [
      {
        filePath: options.importOptions.importRecord.filePath,
        label: 'import',
        line: options.importOptions.importRecord.line,
      },
      {
        filePath: options.importOptions.project.configPath,
        label: 'importing project',
      },
      {
        filePath: options.importOptions.resolution.graphResolvedFilePath,
        label: 'resolved file',
      },
    ],
    packageName: options.packageName,
    presentation: {
      detailLines,
      reason,
      title: 'Workspace source import resolved outside the workspace graph',
    },
    task: 'graph:check',
  };
}

export function addOutsideWorkspaceGraphProblem(
  options: ImportTargetOptions,
): void {
  const targetPackage = getGraphTargetPackage(options);
  if (!targetPackage) {
    return;
  }

  const packageName = getPackageName(targetPackage);
  if (!packageName) {
    return;
  }

  options.context.findings.push(
    createOutsideGraphFinding({
      importOptions: options,
      packageName,
      targetPackage,
    }),
  );
}

function shouldIgnoreUnmappedImport(options: ImportTargetOptions): boolean {
  const conditions = [
    !options.resolution.targetPackageForGraph,
    options.resolution.graphResolvedFilePath.includes('/dist/'),
  ];

  return conditions.includes(true);
}

export function addUnmappedWorkspaceImportProblem(
  options: ImportTargetOptions,
): void {
  if (shouldIgnoreUnmappedImport(options)) {
    return;
  }

  if (!options.resolution.targetWorkspacePackageForResolved) {
    addOutsideWorkspaceGraphProblem(options);
    return;
  }

  addMappedWorkspaceImportProblem(options);
}
