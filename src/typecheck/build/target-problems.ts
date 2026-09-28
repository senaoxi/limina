import type { ResolvedCheckerConfig } from '#config/runner';
import { toRelativePath } from '#utils/path';
import { formatTypecheckOnlyBuildProblem } from './config-path';
import type { OutputBuildResolutionKind } from './target-resolution';

function formatUnmanagedProblem(configLine: string): string {
  return [
    'Unmanaged Limina output build config:',
    configLine,
    '  reason: limina build <config> only accepts source configs managed by Limina checker.include.',
    '  fix: add the owning tsconfig.json entry to a build-capable checker include, or use limina build <config> --raw --preset <checker> for a direct raw build.',
  ].join('\n');
}

function formatOutputlessSolutionProblem(configLine: string): string {
  return [
    'No output-enabled source configs were found under this solution config.',
    configLine,
    '  reason: the solution is Limina-managed, but none of its recursive referenced source leaves declare liminaOptions.outputs.',
    '  fix: Add liminaOptions.outputs to at least one referenced source leaf.',
  ].join('\n');
}

function formatOutputlessProjectProblem(configLine: string): string {
  return [
    'Missing Limina output build options:',
    configLine,
    '  reason: this Limina-managed source config does not declare liminaOptions.outputs.',
    '  fix: add liminaOptions.outputs to this source config, or use limina build <config> --raw --preset <checker> for a direct raw build.',
  ].join('\n');
}

const resolutionProblemFormatters: Readonly<
  Partial<Record<OutputBuildResolutionKind, (configLine: string) => string>>
> = {
  unmanaged: formatUnmanagedProblem,
  'outputless-project': formatOutputlessProjectProblem,
  'outputless-solution': formatOutputlessSolutionProblem,
};

export function formatOutputBuildTargetResolutionProblem(options: {
  matchingCheckers: readonly ResolvedCheckerConfig[];
  projectRootDir: string;
  resolutionKind: OutputBuildResolutionKind;
  sourceConfigPath: string;
}): string {
  const configLine = `  config: ${toRelativePath(
    options.projectRootDir,
    options.sourceConfigPath,
  )}`;
  const formatter = resolutionProblemFormatters[options.resolutionKind];
  if (formatter !== undefined) return formatter(configLine);
  return formatTypecheckOnlyBuildProblem({
    checkers: options.matchingCheckers,
    projectRootDir: options.projectRootDir,
    sourceConfigPath: options.sourceConfigPath,
  });
}
