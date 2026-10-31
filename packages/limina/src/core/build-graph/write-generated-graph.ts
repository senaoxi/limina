import type {
  ResolvedCheckerConfig,
  ResolvedLiminaInputs,
} from '#config/runner';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import { writeGeneratedContent, writeGeneratedJson } from './artifact-writer';
import { declarationPackageFiles } from './declaration-package-format';
import {
  createCheckerBuildConfig,
  createGeneratedDtsConfig,
  createGeneratedOutputProjectConfig,
  createGeneratedOutputSolutionConfig,
  createGeneratedSolutionBuildConfig,
} from './generated-configs';
import type { prepareGeneratedKnipPackageConfigs } from './generated-knip';
import { assertDistinctGeneratedProjectPaths } from './generated/project-paths';
import { libraryProjectionFiles } from './library-projection';
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
  ).map(async (project) => {
    const value = createGeneratedDtsConfig({
      cache: options.cache,
      config: options.config,
      project,
    });
    await writeGeneratedJson({
      context: options.state.writeContext,
      filePath: project.dtsConfigPath,
      value,
    });
    const receipt = project.typeInputProjections?.findLast(
      (candidate) => candidate.generatedConfig === project.dtsConfigPath,
    );
    if (receipt === undefined)
      throw new Error(
        `Declaration output options are unavailable: ${project.dtsConfigPath}`,
      );
    const files = declarationPackageFiles({
      sourceConfig: project.configPath,
      parsed: {
        fileNames: project.fileNames,
        options: receipt.generatedOptions,
        errors: [],
      },
      files: project.virtualFiles,
      compiler: project.context.vueSemanticIdentity?.toolchain.tsModule,
      vueProfiles: project.context.vueSemanticIdentity?.profilesByFileName,
    });
    for (const [filePath, content] of files)
      await writeGeneratedContent({
        context: options.state.writeContext,
        filePath,
        content,
      });
  });
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
  for (const projects of options.state.projectsByChecker.values())
    for (const project of projects) {
      const receipts = project.libraryProjections ?? [];
      for (const receipt of receipts)
        for (const [filePath, content] of libraryProjectionFiles(receipt))
          await writeGeneratedContent({
            context: options.state.writeContext,
            filePath,
            content,
          });
    }
}
