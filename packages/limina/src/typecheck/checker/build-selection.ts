import { getCheckerAdapter } from '#checkers';
import type { BuildCheckerPreset, ResolvedCheckerConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import { uniqueSortedStrings } from '#utils/collections';
import { toRelativePath } from '#utils/path';
import {
  formatManagedBuildCheckerSelectionProblem,
  formatTypecheckOnlyBuildProblem,
  resolveBuildConfigPath,
} from '../build/config-path';
import {
  collectManagedDeclarationBuildTargets,
  type ManagedDeclarationBuildTarget,
} from '../build/target-resolution';
import { createCheckerTarget, type TypecheckTarget } from '../targets';

export type ManagedCheckerBuildSelection =
  | {
      kind: 'problem';
      problem: string;
      sourceConfigPath: string;
    }
  | {
      kind: 'selected';
      selected: ManagedDeclarationBuildTarget[];
      sourceConfigPath: string;
    };

function getBuildCapableTargets(
  targets: readonly ManagedDeclarationBuildTarget[],
): ManagedDeclarationBuildTarget[] {
  return targets.filter(({ checker }) => {
    const adapter = getCheckerAdapter(checker.name);
    return adapter?.execution === 'build';
  });
}

function filterSelectedChecker(options: {
  checker: BuildCheckerPreset | undefined;
  targets: readonly ManagedDeclarationBuildTarget[];
}): ManagedDeclarationBuildTarget[] {
  if (options.checker === undefined) return [...options.targets];
  return options.targets.filter(
    ({ checker }) => checker.name === options.checker,
  );
}

function createUnmanagedConfigProblem(options: {
  projectRootDir: string;
  sourceConfigPath: string;
}): string {
  return [
    'Unmanaged Limina checker build config:',
    `  config: ${toRelativePath(
      options.projectRootDir,
      options.sourceConfigPath,
    )}`,
    '  reason: limina checker build <config> only accepts source configs managed by Limina checker.include.',
    '  fix: add the owning tsconfig.json entry to checker.include, or use limina build <config> --raw --preset <checker> for a direct raw build.',
  ].join('\n');
}

function createSelectionProblem(options: {
  availableCheckers: readonly string[];
  checker: BuildCheckerPreset | undefined;
  managedTargets: readonly ManagedDeclarationBuildTarget[];
  projectRootDir: string;
  sourceConfigPath: string;
}): string {
  if (options.checker !== undefined) {
    return formatManagedBuildCheckerSelectionProblem({
      availableCheckers: options.availableCheckers,
      projectRootDir: options.projectRootDir,
      selectedChecker: options.checker,
      sourceConfigPath: options.sourceConfigPath,
    });
  }
  if (options.managedTargets.length > 0) {
    return formatTypecheckOnlyBuildProblem({
      checkers: options.managedTargets.map(({ checker }) => checker),
      projectRootDir: options.projectRootDir,
      sourceConfigPath: options.sourceConfigPath,
    });
  }
  return createUnmanagedConfigProblem(options);
}

export function selectManagedCheckerBuildTargets(options: {
  allCheckers: readonly ResolvedCheckerConfig[];
  checker: BuildCheckerPreset | undefined;
  configPath: string;
  cwd: string;
  generatedGraph: GeneratedTsconfigGraphResult;
  projectRootDir: string;
}): ManagedCheckerBuildSelection {
  const sourceConfigPath = resolveBuildConfigPath({
    configPath: options.configPath,
    cwd: options.cwd,
    rootDir: options.projectRootDir,
  });
  const managedTargets = collectManagedDeclarationBuildTargets({
    allCheckers: options.allCheckers,
    generatedGraph: options.generatedGraph,
    sourceConfigPath,
  });
  const buildCapable = getBuildCapableTargets(managedTargets);
  const selected = filterSelectedChecker({
    checker: options.checker,
    targets: buildCapable,
  });
  if (selected.length > 0) {
    return { kind: 'selected', selected, sourceConfigPath };
  }
  return {
    kind: 'problem',
    problem: createSelectionProblem({
      availableCheckers: uniqueSortedStrings(
        buildCapable.map(({ checker }) => checker.name),
      ),
      checker: options.checker,
      managedTargets,
      projectRootDir: options.projectRootDir,
      sourceConfigPath,
    }),
    sourceConfigPath,
  };
}

export function createManagedCheckerBuildTargets(options: {
  commandOverride: string | undefined;
  projectRootDir: string;
  selected: readonly ManagedDeclarationBuildTarget[];
  watch: boolean | undefined;
}): TypecheckTarget[] {
  return options.selected.map(({ buildModule, checker, sourceConfigPath }) => ({
    ...createCheckerTarget({
      checker,
      commandOverride: options.commandOverride,
      configPath: buildModule.path,
      executionKind: 'build',
      projectRootDir: options.projectRootDir,
      sourceConfigPath,
      watch: options.watch,
    }),
    sourceConfigPath,
  }));
}

export function createGeneratedCheckerBuildTargets(options: {
  checkers: readonly ResolvedCheckerConfig[];
  commandOverride: string | undefined;
  generatedGraph: GeneratedTsconfigGraphResult;
  projectRootDir: string;
}): TypecheckTarget[] {
  return options.checkers.map((checker) => {
    const configPath = options.generatedGraph.checkerEntries.get(checker.name);
    if (configPath === undefined) {
      throw new Error(`Missing generated entry for checker "${checker.name}".`);
    }
    return createCheckerTarget({
      checker,
      commandOverride: options.commandOverride,
      configPath,
      executionKind: 'build',
      projectRootDir: options.projectRootDir,
    });
  });
}
