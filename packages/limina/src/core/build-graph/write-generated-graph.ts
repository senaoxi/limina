import type {
  ResolvedCheckerConfig,
  ResolvedLiminaInputs,
} from '#config/runner';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import { writeGeneratedJson } from './artifact-writer';
import {
  createCheckerBuildConfig,
  createGeneratedDtsConfig,
  createGeneratedOutputProjectConfig,
  createGeneratedOutputSolutionConfig,
  createGeneratedSolutionBuildConfig,
} from './generated-configs';
import type { prepareGeneratedKnipPackageConfigs } from './generated-knip';
import { assertDistinctGeneratedProjectPaths } from './generated/project-paths';
import type { GeneratedGraphPreparationState } from './prepare-state';

type GeneratedKnipPreparation = ReturnType<
  typeof prepareGeneratedKnipPackageConfigs
>;

function getArrayValue<T>(map: ReadonlyMap<string, T[]>, key: string): T[] {
  return map.get(key) ?? [];
}

function writeDtsProjects(options: {
  cache?: NativeAnalysisCache;
  config: ResolvedLiminaInputs;
  state: GeneratedGraphPreparationState;
  checkerName: string;
}): Promise<void>[] {
  return getArrayValue(
    options.state.projectsByChecker,
    options.checkerName,
  ).map((project) =>
    writeGeneratedJson({
      context: options.state.writeContext,
      filePath: project.dtsConfigPath,
      value: createGeneratedDtsConfig({
        cache: options.cache,
        config: options.config,
        project,
      }),
    }),
  );
}

function writeSolutions(options: {
  config: ResolvedLiminaInputs;
  state: GeneratedGraphPreparationState;
  checkerName: string;
}): Promise<void>[] {
  return getArrayValue(
    options.state.solutionsByChecker,
    options.checkerName,
  ).map((solution) =>
    writeGeneratedJson({
      context: options.state.writeContext,
      filePath: solution.buildConfigPath,
      value: createGeneratedSolutionBuildConfig({
        config: options.config,
        solution,
      }),
    }),
  );
}

function writeOutputProjects(options: {
  cache?: NativeAnalysisCache;
  config: ResolvedLiminaInputs;
  state: GeneratedGraphPreparationState;
  checkerName: string;
}): Promise<void>[] {
  return getArrayValue(
    options.state.outputProjectsByChecker,
    options.checkerName,
  ).map((project) => {
    const value = createGeneratedOutputProjectConfig({
      cache: options.cache,
      config: options.config,
      project,
    });
    return writeGeneratedJson({
      context: options.state.writeContext,
      filePath: project.outputConfigPath,
      value,
    });
  });
}

function writeOutputSolutions(options: {
  config: ResolvedLiminaInputs;
  state: GeneratedGraphPreparationState;
  checkerName: string;
}): Promise<void>[] {
  return getArrayValue(
    options.state.outputSolutionsByChecker,
    options.checkerName,
  ).map((solution) =>
    writeGeneratedJson({
      context: options.state.writeContext,
      filePath: solution.buildConfigPath,
      value: createGeneratedOutputSolutionConfig({
        config: options.config,
        solution,
      }),
    }),
  );
}

function writeCheckerEntry(options: {
  checker: ResolvedCheckerConfig;
  config: ResolvedLiminaInputs;
  entryPath: string;
  state: GeneratedGraphPreparationState;
}): Promise<void> {
  return writeGeneratedJson({
    context: options.state.writeContext,
    filePath: options.entryPath,
    value: createCheckerBuildConfig({
      checkerName: options.checker.name,
      entryPath: options.entryPath,
      references: getArrayValue(
        options.state.rootBuildPathsByChecker,
        options.checker.name,
      ),
      rootDir: options.config.rootDir,
    }),
  });
}

async function writeCheckerArtifacts(options: {
  cache?: NativeAnalysisCache;
  checker: ResolvedCheckerConfig;
  config: ResolvedLiminaInputs;
  state: GeneratedGraphPreparationState;
}): Promise<void> {
  const entryPath = options.state.checkerEntries.get(options.checker.name);
  if (!entryPath) {
    return;
  }
  const base = {
    cache: options.cache,
    checkerName: options.checker.name,
    config: options.config,
    state: options.state,
  };
  await Promise.all([
    ...writeDtsProjects(base),
    ...writeSolutions(base),
    ...writeOutputProjects(base),
    ...writeOutputSolutions(base),
    writeCheckerEntry({ ...options, entryPath }),
  ]);
}

export async function writeGeneratedGraphConfigs(options: {
  cache?: NativeAnalysisCache;
  checkers: ResolvedCheckerConfig[];
  config: ResolvedLiminaInputs;
  generatedKnip: GeneratedKnipPreparation;
  state: GeneratedGraphPreparationState;
}): Promise<void> {
  assertDistinctGeneratedProjectPaths({
    rootDir: options.config.rootDir,
    projects: options.state.projectsByChecker.values().toArray().flat(),
  });
  await Promise.all(
    options.checkers.map((checker) =>
      writeCheckerArtifacts({
        cache: options.cache,
        checker,
        config: options.config,
        state: options.state,
      }),
    ),
  );
  await Promise.all(
    options.generatedKnip.configs.map((entry) =>
      writeGeneratedJson({
        context: options.state.writeContext,
        filePath: entry.configPath,
        value: entry.content,
      }),
    ),
  );
}
