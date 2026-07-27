import type { ResolvedLiminaConfig } from '#config/runner';
import type { collectImportsFromFile } from '#core/import-graph/context';
import { formatImportRecordLocation } from '#core/import-graph/context';
import { toRelativePath } from '#utils/path';
import { getWorkspaceRegionBoundaryExclusionReason } from '../workspace/regions';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import type { SourceProject } from './types';

type ImportRecord = ReturnType<typeof collectImportsFromFile>[number];
type WorkspaceBoundary = NonNullable<
  ReturnType<WorkspaceRegionPathIndex['findBoundaryForPath']>
>;

function getBoundaryAuthorityLine(options: {
  boundary: WorkspaceBoundary;
  config: ResolvedLiminaConfig;
}): string {
  if (options.boundary.kind === 'pnpm-workspace') {
    return `  boundary config: ${toRelativePath(options.config.rootDir, options.boundary.workspaceYamlPath)}`;
  }
  return `  boundary manifest: ${toRelativePath(options.config.rootDir, options.boundary.packageJsonPath)}`;
}

function getBoundaryReasonLines(boundary: WorkspaceBoundary): string[] {
  const reason = getWorkspaceRegionBoundaryExclusionReason(boundary);
  return reason ? [`  excluded boundary reason: ${reason}`] : [];
}

function formatBoundaryProblem(options: {
  boundary: WorkspaceBoundary;
  config: ResolvedLiminaConfig;
  importRecord: ImportRecord;
  project: SourceProject;
  resolvedFilePath: string;
}): string {
  return [
    'Generated graph import crosses governance boundary:',
    `  importing config: ${toRelativePath(options.config.rootDir, options.project.configPath)}`,
    `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  resolved file: ${toRelativePath(options.config.rootDir, options.resolvedFilePath)}`,
    `  boundary kind: ${options.boundary.kind}`,
    `  boundary root: ${toRelativePath(options.config.rootDir, options.boundary.rootDir)}`,
    getBoundaryAuthorityLine(options),
    ...getBoundaryReasonLines(options.boundary),
    '  reason: generated graph provider inference cannot cross a stopped or excluded governance boundary.',
  ].join('\n');
}

function formatOutsideRegionProblem(options: {
  config: ResolvedLiminaConfig;
  importRecord: ImportRecord;
  project: SourceProject;
  resolvedFilePath: string;
}): string {
  return [
    'Generated graph import resolves outside activated workspace package regions:',
    `  importing config: ${toRelativePath(options.config.rootDir, options.project.configPath)}`,
    `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  resolved file: ${toRelativePath(options.config.rootDir, options.resolvedFilePath)}`,
    '  reason: generated graph provider inference is bounded by current-run workspace packages.',
  ].join('\n');
}

export function formatReferenceBoundaryProblem(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  config: ResolvedLiminaConfig;
  importRecord: ImportRecord;
  project: SourceProject;
  resolvedFilePath: string;
}): string {
  const boundary = options.activatedRegions.findBoundaryForPath(
    options.resolvedFilePath,
  );
  return boundary
    ? formatBoundaryProblem({ ...options, boundary })
    : formatOutsideRegionProblem(options);
}
