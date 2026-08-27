import type { ResolvedLiminaConfig } from '#config/runner';
import { uniqueCodeUnitSortedStrings } from '#utils/collections';
import { toRelativePath } from '#utils/path';
import { getWorkspaceRegionBoundaryExclusionReason } from '../../core/workspace/regions';
import type { WorkspaceRegionPathIndex } from '../../core/workspace/validated-context';

export function formatConfigPath(
  config: ResolvedLiminaConfig,
  configPath: string,
): string {
  return toRelativePath(config.rootDir, configPath);
}

export function createUnsupportedNamedSolutionError(
  config: ResolvedLiminaConfig,
  configPaths: Iterable<string>,
): Error {
  const relativePaths = uniqueCodeUnitSortedStrings(
    [...configPaths].map((configPath) =>
      formatConfigPath(config, configPath).replaceAll('\\', '/'),
    ),
  );
  return new Error(
    [
      'Migration found TypeScript solution configs with unsupported filenames:',
      ...relativePaths.map((configPath) => `  - ${configPath}`),
      '',
      'reason:',
      '  These configs resolve to zero source files and declare references, so',
      '  TypeScript treats them as solution configs. Limina only supports that',
      '  role at a tsconfig.json entry path.',
      '',
      'fix:',
      '  - Rename the config to tsconfig.json when the directory has no existing default entry; or',
      "  - Merge its references into the directory's existing tsconfig.json; or",
      '  - Convert it into a real source leaf by removing references and defining',
      '    an effective source boundary.',
    ].join('\n'),
  );
}

function createBoundaryDetails(options: {
  config: ResolvedLiminaConfig;
  pathIndex: WorkspaceRegionPathIndex;
  referencePath: string;
}): string[] {
  const boundary = options.pathIndex.findBoundaryForPath(options.referencePath);
  if (boundary === null) {
    return [
      '  reason: the referenced config is not owned by any current-run activated workspace package.',
    ];
  }
  const details = [
    `  boundary kind: ${boundary.kind}`,
    `  boundary root: ${formatConfigPath(options.config, boundary.rootDir)}`,
  ];
  const reason = getWorkspaceRegionBoundaryExclusionReason(boundary);
  if (reason !== null) {
    details.push(`  boundary exclusion reason: ${reason}`);
  }
  details.push(
    '  reason: the referenced config is outside the current activated workspace package region.',
  );
  return details;
}

export function createBoundaryError(options: {
  config: ResolvedLiminaConfig;
  pathIndex: WorkspaceRegionPathIndex;
  referencePath: string;
  sourceConfigPath: string;
}): Error {
  const details = createBoundaryDetails(options);
  return new Error(
    [
      'Referenced checker source config is outside activated workspace package regions:',
      `  from config: ${formatConfigPath(options.config, options.sourceConfigPath)}`,
      `  referenced config: ${formatConfigPath(options.config, options.referencePath)}`,
      ...details,
    ].join('\n'),
  );
}
