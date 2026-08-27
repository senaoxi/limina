import type { ResolvedLiminaConfig } from '#config/runner';
import { toRelativePath } from '#utils/path';
import { readOutputOptions } from './generated/config-readers';
import type { GovernedSourceUnit, SolutionProject } from './types';

function formatFrameworkOutputProblem(options: {
  config: ResolvedLiminaConfig;
  unit: GovernedSourceUnit;
}): string {
  const families = options.unit.frameworkCapabilities
    .map((capability) => capability.family)
    .join(', ');
  return [
    'Framework source configs cannot declare Limina application outputs:',
    `  config: ${toRelativePath(options.config.rootDir, options.unit.configPath)}`,
    `  capabilities: ${families}`,
    '  field: liminaOptions.outputs',
    '  reason: Limina only projects TypeScript declaration builds and does not build Astro or Svelte applications.',
    '  fix: remove liminaOptions.outputs and run the framework application build with its owning framework tool.',
  ].join('\n');
}

export function addFrameworkOutputProblems(options: {
  config: ResolvedLiminaConfig;
  governedSources: readonly GovernedSourceUnit[];
  problems: string[];
}): void {
  options.problems.push(
    ...options.governedSources.flatMap((unit) => {
      if (unit.frameworkCapabilities.length === 0) return [];
      const output = readOutputOptions(options.config, unit.configPath);
      return output.outputs === null
        ? []
        : [formatFrameworkOutputProblem({ config: options.config, unit })];
    }),
  );
}

function synchronizeProjectionSolution(
  solution: SolutionProject,
  unitByBuildPath: ReadonlyMap<string, GovernedSourceUnit>,
): void {
  const unit = unitByBuildPath.get(solution.buildConfigPath);
  if (unit === undefined) return;
  const projection = unit.buildProjection;
  solution.references = new Set(
    'dtsConfigPath' in projection ? [projection.dtsConfigPath] : [],
  );
}

export function synchronizeProjectionSolutionReferences(options: {
  governedSources: readonly GovernedSourceUnit[];
  solutions: readonly SolutionProject[];
}): void {
  const unitByBuildPath = new Map(
    options.governedSources.flatMap((unit) => {
      const projection = unit.buildProjection;
      return 'buildConfigPath' in projection
        ? [[projection.buildConfigPath, unit] as const]
        : [];
    }),
  );
  for (const solution of options.solutions) {
    synchronizeProjectionSolution(solution, unitByBuildPath);
  }
}
