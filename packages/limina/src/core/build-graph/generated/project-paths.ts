import type { SourceProject } from '../types';
import {
  getGeneratedOutDir as getGeneratedOutDirectory,
  getGeneratedOutputTsBuildInfoPath,
  getGeneratedTsBuildInfoPath,
} from './paths';

type ProjectPathOwner = Pick<
  SourceProject,
  | 'checkerName'
  | 'configPath'
  | 'dtsConfigPath'
  | 'outputConfigPath'
  | 'outputOptions'
  | 'packageRootDir'
>;

function getProjectPaths(
  rootDirectory: string,
  project: ProjectPathOwner,
): string[] {
  const options = {
    checkerName: project.checkerName,
    packageRootDir: project.packageRootDir,
    rootDir: rootDirectory,
    sourceConfigPath: project.configPath,
  };
  const paths = [
    project.dtsConfigPath,
    getGeneratedOutDirectory(options),
    getGeneratedTsBuildInfoPath(options),
  ];
  if (project.outputOptions !== null) {
    paths.push(
      project.outputConfigPath,
      getGeneratedOutputTsBuildInfoPath(options),
    );
  }
  return paths;
}

function registerPath(
  owners: Map<string, string>,
  filePath: string,
  source: string,
): void {
  const existing = owners.get(filePath);
  if (existing === undefined) {
    owners.set(filePath, source);
    return;
  }
  if (existing !== source) {
    throw new Error(
      `Generated project path collision: ${filePath}\n  source config: ${existing}\n  source config: ${source}`,
    );
  }
}

export function assertDistinctGeneratedProjectPaths(options: {
  rootDir: string;
  projects: readonly ProjectPathOwner[];
}): void {
  const owners = new Map<string, string>();
  for (const project of options.projects) {
    for (const filePath of getProjectPaths(options.rootDir, project)) {
      registerPath(owners, filePath, project.configPath);
    }
  }
}
