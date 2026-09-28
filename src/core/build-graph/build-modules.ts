import {
  getGeneratedDtsConfigPath,
  getGeneratedOutputProjectConfigPath,
  getGeneratedOutputSolutionConfigPath,
  getGeneratedSolutionBuildConfigPath,
} from './generated/paths';
import type { GeneratedBuildModule } from './types';

interface BuildModulePathOptions {
  checkerName: string;
  packageRootDir: string;
  rootDir: string;
  sourceConfigPath: string;
}

export function createProjectBuildModule(
  options: BuildModulePathOptions,
): GeneratedBuildModule {
  return { kind: 'project', path: getGeneratedDtsConfigPath(options) };
}

export function createSolutionBuildModule(
  options: BuildModulePathOptions,
): GeneratedBuildModule {
  return {
    kind: 'solution',
    path: getGeneratedSolutionBuildConfigPath(options),
  };
}

export function createOutputProjectBuildModule(
  options: BuildModulePathOptions,
): GeneratedBuildModule {
  return {
    kind: 'project',
    path: getGeneratedOutputProjectConfigPath(options),
  };
}

export function createOutputSolutionBuildModule(
  options: BuildModulePathOptions,
): GeneratedBuildModule {
  return {
    kind: 'solution',
    path: getGeneratedOutputSolutionConfigPath(options),
  };
}
