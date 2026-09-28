import type { ResolvedLiminaConfig } from '#config/runner';
import { toRelativePath } from '#utils/path';
import { getWorkspaceRegionBoundaryExclusionReason } from '../workspace/regions';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';

function getConfigLines(options: {
  config: ResolvedLiminaConfig;
  referencedFromConfigPath?: string;
  sourceConfigPath: string;
}): string[] {
  if (!options.referencedFromConfigPath) {
    return [
      `  config: ${toRelativePath(options.config.rootDir, options.sourceConfigPath)}`,
    ];
  }
  return [
    `  from config: ${toRelativePath(options.config.rootDir, options.referencedFromConfigPath)}`,
    `  referenced config: ${toRelativePath(options.config.rootDir, options.sourceConfigPath)}`,
  ];
}

function getBoundaryLines(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  config: ResolvedLiminaConfig;
  sourceConfigPath: string;
}): string[] {
  const boundary = options.activatedRegions.findBoundaryForPath(
    options.sourceConfigPath,
  );
  if (!boundary) {
    return [
      '  reason: the referenced config is not owned by any current-run activated workspace package.',
    ];
  }

  const reason = getWorkspaceRegionBoundaryExclusionReason(boundary);
  const reasonLines = reason ? [`  boundary exclusion reason: ${reason}`] : [];
  return [
    `  boundary kind: ${boundary.kind}`,
    `  boundary root: ${toRelativePath(options.config.rootDir, boundary.rootDir)}`,
    ...reasonLines,
    '  reason: the referenced config is outside the current activated workspace package region.',
  ];
}

export function getOutsideRegionProblem(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  checkerName: string;
  config: ResolvedLiminaConfig;
  referencedFromConfigPath?: string;
  sourceConfigPath: string;
}): string {
  const heading = options.referencedFromConfigPath
    ? 'Referenced checker source config is outside activated workspace package regions:'
    : 'Checker source config is outside activated workspace package regions:';
  return [
    heading,
    `  checker: ${options.checkerName}`,
    ...getConfigLines(options),
    ...getBoundaryLines(options),
  ].join('\n');
}

export function getInvalidSolutionOutputProblem(options: {
  config: ResolvedLiminaConfig;
  sourceConfigPath: string;
}): string {
  return [
    'Invalid Limina output options:',
    `  config: ${toRelativePath(options.config.rootDir, options.sourceConfigPath)}`,
    '  field: liminaOptions.outputs',
    '  reason: liminaOptions.outputs is only allowed on ordinary source leaf configs, not TypeScript solution configs.',
    '  fix: move liminaOptions.outputs to one or more referenced source leaf tsconfigs.',
  ].join('\n');
}
