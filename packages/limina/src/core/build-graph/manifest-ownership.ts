import type { ResolvedCheckerConfig } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { toPosixPath, toRelativePath } from '#utils/path';
import type { CheckerOwnershipPlan } from './checker-ownership-types';
import type {
  GeneratedTsconfigGraphManifest,
  GovernedSourceUnit,
} from './types';

function toManifestPath(rootDir: string, filePath: string): string {
  return toPosixPath(toRelativePath(rootDir, filePath));
}

function requireFinalOwner(options: {
  configPath: string;
  owner: ResolvedCheckerConfig['name'] | undefined;
}): ResolvedCheckerConfig['name'] {
  if (options.owner !== undefined) return options.owner;
  throw new Error(`Missing final checker owner for ${options.configPath}.`);
}

export function createOwnershipManifest(options: {
  ownershipPlan?: CheckerOwnershipPlan;
  rootDir: string;
}): GeneratedTsconfigGraphManifest['ownership'] {
  if (options.ownershipPlan === undefined) {
    return { configs: [], solutions: [] };
  }
  const typeConfigs = [...options.ownershipPlan.typeConfigs.values()].map(
    (state) => ({
      config: toManifestPath(options.rootDir, state.configPath),
      owner: requireFinalOwner({
        configPath: state.configPath,
        owner: state.finalOwner,
      }),
      role: 'type' as const,
    }),
  );
  const solutions = [...options.ownershipPlan.solutions.values()].map(
    (state) => ({
      config: toManifestPath(options.rootDir, state.configPath),
      leaves: state.leafConfigPaths.map((configPath) =>
        toManifestPath(options.rootDir, configPath),
      ),
      owner: requireFinalOwner({
        configPath: state.configPath,
        owner: state.finalOwner,
      }),
    }),
  );
  return {
    configs: [
      ...typeConfigs,
      ...solutions.map((solution) => ({
        config: solution.config,
        owner: solution.owner,
        role: 'solution' as const,
      })),
    ].sort((left, right) => compareCodeUnits(left.config, right.config)),
    solutions: solutions.sort((left, right) =>
      compareCodeUnits(left.config, right.config),
    ),
  };
}

function createFrameworkTarget(options: {
  rootDir: string;
  unit: GovernedSourceUnit;
}): GeneratedTsconfigGraphManifest['targets']['framework'] {
  if (
    options.unit.primaryCheckerName !== 'astro' &&
    options.unit.primaryCheckerName !== 'svelte-check'
  ) {
    return [];
  }
  return [
    {
      checker: options.unit.primaryCheckerName,
      config: toManifestPath(options.rootDir, options.unit.configPath),
      packageRoot: toManifestPath(options.rootDir, options.unit.packageRootDir),
    },
  ];
}

export function createExecutionTargets(options: {
  checkers: GeneratedTsconfigGraphManifest['checkers'];
  governedSourcesByChecker: ReadonlyMap<string, GovernedSourceUnit[]>;
  rootDir: string;
}): GeneratedTsconfigGraphManifest['targets'] {
  const build = Object.values(options.checkers)
    .map((checker) => ({
      checker: checker.name as ResolvedCheckerConfig['name'],
      entry: checker.entry,
      roots: [...checker.roots],
    }))
    .sort((left, right) => compareCodeUnits(left.checker, right.checker));
  const framework = [...options.governedSourcesByChecker.values()]
    .flat()
    .flatMap((unit) => createFrameworkTarget({ ...options, unit }))
    .sort((left, right) => compareCodeUnits(left.config, right.config));
  return { build, framework };
}
