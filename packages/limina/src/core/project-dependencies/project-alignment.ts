import type { LockedSemanticAuthority } from '../build-graph/checker-ownership-types';
import { getCheckerSemanticFamily } from '../build-graph/checker-semantic-authority';
import type {
  GeneratedTsconfigGraphResult,
  GovernedSourceUnit,
} from '../build-graph/types';
import type { ProjectInfo } from '../import-graph/project-types';

function getUnitProjectPaths(unit: GovernedSourceUnit): string[] {
  const projection = unit.buildProjection;
  return [
    unit.configPath,
    'buildConfigPath' in projection ? projection.buildConfigPath : undefined,
    'dtsConfigPath' in projection ? projection.dtsConfigPath : undefined,
  ].filter((value): value is string => value !== undefined);
}

function createUnitByProjectPath(
  generatedGraph: GeneratedTsconfigGraphResult,
): Map<string, GovernedSourceUnit> {
  const result = new Map<string, GovernedSourceUnit>();
  for (const units of generatedGraph.governedSources.values()) {
    addUnitsByProjectPath(result, units.values());
  }
  return result;
}

function addUnitsByProjectPath(
  result: Map<string, GovernedSourceUnit>,
  units: Iterable<GovernedSourceUnit>,
): void {
  for (const unit of units) addUnitByProjectPath(result, unit);
}

function addUnitByProjectPath(
  result: Map<string, GovernedSourceUnit>,
  unit: GovernedSourceUnit,
): void {
  for (const projectPath of getUnitProjectPaths(unit)) {
    result.set(projectPath, unit);
  }
}

function createTypeScriptRouteAuthority(
  project: ProjectInfo,
): LockedSemanticAuthority | undefined {
  const families = new Set(
    project.checkerPresets.map(getCheckerSemanticFamily),
  );
  if (families.size !== 1 || !families.has('typescript')) return undefined;
  return { family: 'typescript', kind: 'locked', source: 'explicit' };
}

function alignWithoutGovernedUnit(project: ProjectInfo): ProjectInfo {
  const semanticAuthority = createTypeScriptRouteAuthority(project);
  return semanticAuthority === undefined
    ? project
    : { ...project, semanticAuthority };
}

export function alignProjectWithFrozenSemanticAuthority(options: {
  generatedGraph: GeneratedTsconfigGraphResult;
  project: ProjectInfo;
}): ProjectInfo {
  const unit = createUnitByProjectPath(options.generatedGraph).get(
    options.project.configPath,
  );
  if (unit === undefined) return alignWithoutGovernedUnit(options.project);
  return {
    ...options.project,
    astroSemanticProject: unit.astroSemanticProject,
    semanticAuthority: { ...unit.semanticAuthority },
    svelteSemanticProject: unit.svelteSemanticProject,
  };
}

export function alignProjectsWithFrozenSemanticAuthority(options: {
  generatedGraph: GeneratedTsconfigGraphResult;
  projects: readonly ProjectInfo[];
}): ProjectInfo[] {
  const unitByProjectPath = createUnitByProjectPath(options.generatedGraph);
  return options.projects.map((project) => {
    const unit = unitByProjectPath.get(project.configPath);
    if (unit === undefined) return alignWithoutGovernedUnit(project);
    return {
      ...project,
      astroSemanticProject: unit.astroSemanticProject,
      semanticAuthority: { ...unit.semanticAuthority },
      svelteSemanticProject: unit.svelteSemanticProject,
    };
  });
}
