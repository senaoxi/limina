import type {
  ResolvedCheckerConfig,
  ResolvedLiminaConfig,
} from '#config/runner';
import { writeGeneratedJson } from './artifact-writer';
import {
  createCheckerBuildConfig,
  createGeneratedDtsConfig,
  createGeneratedOutputProjectConfig,
  createGeneratedOutputSolutionConfig,
  createGeneratedSolutionBuildConfig,
} from './generated-configs';
import type { prepareGeneratedKnipPackageConfigs } from './generated-knip';
import type { GeneratedGraphPreparationState } from './prepare-state';

type GeneratedKnipPreparation = ReturnType<
  typeof prepareGeneratedKnipPackageConfigs
>;

function getArrayValue<T>(map: ReadonlyMap<string, T[]>, key: string): T[] {
  return map.get(key) ?? [];
}

function writeDtsProjects(options: {
  config: ResolvedLiminaConfig;
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
      value: createGeneratedDtsConfig({ config: options.config, project }),
    }),
  );
}

function writeSolutions(options: {
  config: ResolvedLiminaConfig;
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
  config: ResolvedLiminaConfig;
  state: GeneratedGraphPreparationState;
  checkerName: string;
}): Promise<void>[] {
  return getArrayValue(
    options.state.outputProjectsByChecker,
    options.checkerName,
  ).map((project) =>
    writeGeneratedJson({
      context: options.state.writeContext,
      filePath: project.outputConfigPath,
      value: createGeneratedOutputProjectConfig({
        config: options.config,
        project,
      }),
    }),
  );
}

function writeOutputSolutions(options: {
  config: ResolvedLiminaConfig;
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
  config: ResolvedLiminaConfig;
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
  checker: ResolvedCheckerConfig;
  config: ResolvedLiminaConfig;
  state: GeneratedGraphPreparationState;
}): Promise<void> {
  const entryPath = options.state.checkerEntries.get(options.checker.name);
  if (!entryPath) {
    return;
  }
  const base = {
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
  checkers: ResolvedCheckerConfig[];
  config: ResolvedLiminaConfig;
  generatedKnip: GeneratedKnipPreparation;
  state: GeneratedGraphPreparationState;
}): Promise<void> {
  await Promise.all(
    options.checkers.map((checker) =>
      writeCheckerArtifacts({
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
