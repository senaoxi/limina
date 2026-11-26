import type { ResolvedLiminaInputs } from '#config/runner';
import { toRelativePath } from '#utils/path';
import { isNodeModulesPath } from '../workspace/lookup/shared';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import { createGeneratedGraphStructuredError } from './problems';

export function sourcePackageScopeProblems(
  config: ResolvedLiminaInputs,
  regions: WorkspaceRegionPathIndex,
  configPath: string,
  ownedFiles: readonly string[],
): string[] {
  const scope = regions.packageScopeForFile(configPath);
  const compilerScope = regions.compilerPackageScopeForFile(configPath);
  const relative = (file: string | undefined) =>
    file === undefined
      ? '(outside regions)'
      : toRelativePath(config.rootDir, file);
  if (scope === undefined || compilerScope !== scope)
    return [
      [
        'Source project crosses its nearest package.json scope:',
        `  config: ${relative(configPath)}`,
        `  config package.json: ${relative(scope)}`,
        `  compiler path config package.json: ${relative(compilerScope)}`,
        '  reason: a source leaf must bind to one active package.json through both its compiler path and its physical path.',
      ].join('\n'),
    ];
  return ownedFiles.flatMap((file) => {
    const target = isNodeModulesPath(regions.classifyPath(file).canonicalPath)
      ? undefined
      : regions.packageScopeForFile(file);
    const compilerTarget = regions.compilerPackageScopeForFile(file);
    if (target === scope && compilerTarget === scope) return [];
    return [
      [
        target === undefined
          ? 'Source project owns files outside activated workspace package regions:'
          : 'Source project crosses its nearest package.json scope:',
        `  config: ${relative(configPath)}`,
        `  config package.json: ${relative(scope)}`,
        `  file: ${relative(file)}`,
        `  file package.json: ${relative(target)}`,
        ...(compilerTarget === target
          ? []
          : [`  compiler path file package.json: ${relative(compilerTarget)}`]),
        '  reason: a source leaf and each of its directly governed roots must share their nearest active package.json.',
      ].join('\n'),
    ];
  });
}

export function assertSourcePackageScopes(
  config: ResolvedLiminaInputs,
  regions: WorkspaceRegionPathIndex,
  projects: Iterable<{ configPath: string; fileNames: readonly string[] }>,
): void {
  const problems = [...projects].flatMap((project) =>
    sourcePackageScopeProblems(
      config,
      regions,
      project.configPath,
      project.fileNames,
    ),
  );
  if (problems.length > 0)
    throw createGeneratedGraphStructuredError({
      config,
      fallback: 'Invalid source project ownership.',
      problems,
    });
}
