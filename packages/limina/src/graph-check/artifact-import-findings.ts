import {
  formatArtifactDependencyPolicy,
  formatImportRecordLocation,
  inferPackageProject,
  shouldResolveThroughGraph,
} from '#core/import-graph/context';
import type { WorkspacePackage } from '#core/workspace/actions';
import { toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { LiminaCheckIssueLocation } from '../check-reporting/snapshot';
import { createGraphImportFact, getProjectCheckerName } from './finding-utils';
import type { GraphWorkspaceImportOutsideGraphFinding } from './findings';
import type { ImportTargetOptions } from './import-target-types';

interface NamedWorkspacePackage extends WorkspacePackage {
  name: string;
}

function isGraphSourceDependency(options: ImportTargetOptions): boolean {
  const targetPackage = options.resolution.targetPackageForGraph;
  if (!targetPackage) {
    return false;
  }

  return shouldResolveThroughGraph(options.resolution.importer, targetPackage);
}

export function shouldSkipWorkspaceExportResolvedOutsideGraph(
  options: ImportTargetOptions,
): boolean {
  const conditions = [
    isGraphSourceDependency(options),
    Boolean(options.resolution.workspaceExportResolution),
    !options.context.fileOwnerLookup.has(
      options.resolution.graphResolvedFilePath,
    ),
  ];

  return conditions.every(Boolean);
}

function isBuildArtifactCandidate(options: ImportTargetOptions): boolean {
  const conditions = [
    isGraphSourceDependency(options),
    !options.resolution.workspaceExportResolution,
    !options.context.fileOwnerLookup.has(options.resolution.resolvedFilePath),
  ];

  return conditions.every(Boolean);
}

function isNamedPackage(
  packageInfo: WorkspacePackage,
): packageInfo is NamedWorkspacePackage {
  return typeof packageInfo.name === 'string' && packageInfo.name.length > 0;
}

function asNamedPackage(
  packageInfo: WorkspacePackage,
): NamedWorkspacePackage | null {
  return isNamedPackage(packageInfo) ? packageInfo : null;
}

function getBuildArtifactPackage(
  options: ImportTargetOptions,
): NamedWorkspacePackage | null {
  if (!isBuildArtifactCandidate(options)) {
    return null;
  }

  const targetPackage = options.resolution.targetPackageForGraph;
  if (!targetPackage) {
    return null;
  }

  return asNamedPackage(targetPackage);
}

function getReferencedProjectPath(
  options: ImportTargetOptions,
): string | undefined {
  const targetPackage = options.resolution.targetPackageForGraph;
  if (!targetPackage) {
    return undefined;
  }

  return (
    inferPackageProject(
      options.resolution.resolvedFilePath,
      targetPackage,
      options.context.projectPaths,
    ) ?? undefined
  );
}

function hasProjectReference(
  options: ImportTargetOptions,
  referencedProjectPath: string | undefined,
): boolean {
  if (!referencedProjectPath) {
    return false;
  }

  return options.project.references.has(referencedProjectPath);
}

function getBuildArtifactTitle(hasReference: boolean): string {
  return hasReference
    ? 'Referenced workspace dependency resolves through package exports to a build artifact'
    : 'Workspace source dependency resolved outside the source graph';
}

function createReferencedProjectLines(options: {
  context: ImportTargetOptions['context'];
  hasReference: boolean;
  referencedProjectPath?: string;
}): string[] {
  if (!options.referencedProjectPath) {
    return [];
  }

  return [
    `  referenced project: ${toRelativePath(options.context.config.rootDir, options.referencedProjectPath)}`,
    `  project reference present: ${options.hasReference ? 'yes' : 'no'}`,
  ];
}

function createReferencedProjectFact(referencedProjectPath?: string): {
  referencedProjectPath?: string;
} {
  return referencedProjectPath ? { referencedProjectPath } : {};
}

function createBuildArtifactLocations(options: {
  importOptions: ImportTargetOptions;
  referencedProjectPath?: string;
}): GraphWorkspaceImportOutsideGraphFinding['locations'] {
  const locations: LiminaCheckIssueLocation[] = [
    {
      filePath: options.importOptions.importRecord.filePath,
      label: 'import',
      line: options.importOptions.importRecord.line,
    },
    {
      filePath: options.importOptions.project.configPath,
      label: 'importing project',
    },
  ];

  if (options.referencedProjectPath) {
    locations.push({
      filePath: options.referencedProjectPath,
      label: 'referenced project',
    });
  }

  locations.push({
    filePath: options.importOptions.resolution.resolvedFilePath,
    label: 'resolved file',
  });
  return locations;
}

function createBuildArtifactFinding(options: {
  importOptions: ImportTargetOptions;
  referencedProjectPath?: string;
  targetPackage: NamedWorkspacePackage;
}): GraphWorkspaceImportOutsideGraphFinding {
  const hasReference = hasProjectReference(
    options.importOptions,
    options.referencedProjectPath,
  );
  const title = getBuildArtifactTitle(hasReference);
  const reason =
    'this import resolved to a file not owned by the source graph, so it is not a source project-reference edge.';
  const fix = `point the dependency package export at source files, or treat this relationship as artifact consumption; ${formatArtifactDependencyPolicy(options.targetPackage)}`;
  const detailLines = [
    `${title}:`,
    `  importing project: ${toRelativePath(options.importOptions.context.config.rootDir, options.importOptions.project.configPath)}`,
    ...createReferencedProjectLines({
      context: options.importOptions.context,
      hasReference,
      referencedProjectPath: options.referencedProjectPath,
    }),
    `  file: ${formatImportRecordLocation(options.importOptions.context.config.rootDir, options.importOptions.importRecord)}`,
    `  imported specifier: ${options.importOptions.importRecord.specifier}`,
    `  resolved file: ${toRelativePath(options.importOptions.context.config.rootDir, options.importOptions.resolution.resolvedFilePath)}`,
    `  reason: ${reason}`,
    `  fix: ${fix}`,
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
        value: options.importOptions.resolution.resolvedFilePath,
      },
    ],
    facts: {
      import: createGraphImportFact(options.importOptions.importRecord),
      importingProjectPath: options.importOptions.project.configPath,
      kind: 'build-artifact',
      ...createReferencedProjectFact(options.referencedProjectPath),
      resolvedFilePath: options.importOptions.resolution.resolvedFilePath,
      targetPackageName: options.targetPackage.name,
    },
    filePath: options.importOptions.importRecord.filePath,
    locations: createBuildArtifactLocations({
      importOptions: options.importOptions,
      referencedProjectPath: options.referencedProjectPath,
    }),
    packageName: options.targetPackage.name,
    presentation: { detailLines, fix, reason, title },
    task: 'graph:check',
  };
}

export function addBuildArtifactImportProblem(
  options: ImportTargetOptions,
): boolean {
  const targetPackage = getBuildArtifactPackage(options);
  if (!targetPackage) {
    return false;
  }

  options.context.findings.push(
    createBuildArtifactFinding({
      importOptions: options,
      referencedProjectPath: getReferencedProjectPath(options),
      targetPackage,
    }),
  );
  return true;
}
