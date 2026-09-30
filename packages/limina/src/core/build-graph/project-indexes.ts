import {
  type CheckerBuildEngine,
  getCheckerBuildEngine,
  isBuildCapablePreset,
} from '#checkers';
import type { SourceProject } from './types';

export function createSourceProjectsByDtsPath(
  projects: SourceProject[],
): Map<string, SourceProject> {
  return new Map(projects.map((project) => [project.dtsConfigPath, project]));
}

export function createDtsProjectsBySourcePath(
  projects: SourceProject[],
): Map<string, SourceProject[]> {
  return Map.groupBy(projects, (project) => project.configPath);
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

export function isBuildCapableProject(project: SourceProject): boolean {
  const preset = project.context.checkerPresets[0];
  return Boolean(preset) && isBuildCapablePreset(preset);
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
