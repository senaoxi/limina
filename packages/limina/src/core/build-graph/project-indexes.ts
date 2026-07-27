import {
  type CheckerBuildEngine,
  getCheckerBuildEngine,
  isBuildCapablePreset,
} from '#checkers';
import type { ManagedOutputProjectContext } from '../import-graph/managed-output-provider';
import type { OutputOptions } from './generated/config-readers';
import type { SourceProject } from './types';

export function createSourceProjectsByDtsPath(
  projects: SourceProject[],
): Map<string, SourceProject> {
  return new Map(projects.map((project) => [project.dtsConfigPath, project]));
}

export function createDtsProjectsBySourcePath(
  projects: SourceProject[],
): Map<string, SourceProject[]> {
  const projectsBySourcePath = new Map<string, SourceProject[]>();
  for (const project of projects) {
    const projectsForSource =
      projectsBySourcePath.get(project.configPath) ?? [];
    projectsForSource.push(project);
    projectsBySourcePath.set(project.configPath, projectsForSource);
  }
  return projectsBySourcePath;
}

export function getDtsConfigPathForSourcePath(options: {
  checkerName: string;
  dtsProjectsBySourcePath: Map<string, SourceProject[]>;
  sourceConfigPath: string;
}): string | undefined {
  const candidates =
    options.dtsProjectsBySourcePath.get(options.sourceConfigPath) ?? [];
  return candidates.find(
    (project) => project.checkerName === options.checkerName,
  )?.dtsConfigPath;
}

export function getDtsProjectsForSourcePath(options: {
  dtsProjectsBySourcePath: Map<string, SourceProject[]>;
  sourceConfigPath: string;
}): SourceProject[] {
  return options.dtsProjectsBySourcePath.get(options.sourceConfigPath) ?? [];
}

export function createManagedOutputProjectContexts(
  projects: SourceProject[],
): ManagedOutputProjectContext[] {
  return projects
    .filter(
      (project): project is SourceProject & { outputOptions: OutputOptions } =>
        Boolean(project.outputOptions),
    )
    .map((project) => ({
      checkerName: project.checkerName,
      sourceConfigPath: project.configPath,
      outputOptions: {
        outDir: project.outputOptions.outDir,
        rootDir: project.outputOptions.rootDir,
      },
      ownedFileNames: project.ownedFileNames,
      extensions: project.context.extensions,
    }));
}

export function isBuildCapableProject(project: SourceProject): boolean {
  const preset = project.context.checkerPresets[0];
  return preset ? isBuildCapablePreset(preset) : false;
}

export function getSourceProjectPreset(project: SourceProject): string {
  return project.context.checkerPresets[0] ?? 'unknown';
}

export function getSourceProjectBuildEngine(
  project: SourceProject,
): CheckerBuildEngine {
  const preset = project.context.checkerPresets[0];
  return preset ? getCheckerBuildEngine(preset) : 'unknown';
}
