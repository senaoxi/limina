import type { CheckerBuildEngine } from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { toRelativePath } from '#utils/path';
import { getGeneratedOutputTsBuildInfoPath } from './generated/paths';
import {
  getSourceProjectBuildEngine,
  getSourceProjectPreset,
  isBuildCapableProject,
} from './project-indexes';
import type { ProviderSelectionResult, SourceProject } from './types';

export function sortSourceProjectsByChecker(
  projects: SourceProject[],
): SourceProject[] {
  return [...projects].sort(
    (left, right) =>
      compareCodeUnits(left.checkerName, right.checkerName) ||
      compareCodeUnits(left.configPath, right.configPath),
  );
}

export function formatSourceProjectWithEngine(project: SourceProject): string {
  return `${project.checkerName} (${getSourceProjectPreset(project)}, engine: ${getSourceProjectBuildEngine(project)})`;
}

export function formatProviderCandidateLines(
  candidates: SourceProject[],
): string[] {
  return sortSourceProjectsByChecker(candidates).map(
    (candidate) => `    - ${formatSourceProjectWithEngine(candidate)}`,
  );
}

function collectProviderProjects(options: {
  consumerProject: SourceProject;
  providerSourceFilePath: string;
  targetProjects: SourceProject[];
}): SourceProject[] {
  return options.targetProjects
    .filter(
      (project) => project.checkerName !== options.consumerProject.checkerName,
    )
    .filter((project) =>
      project.ownedFileNames.includes(options.providerSourceFilePath),
    )
    .filter(isBuildCapableProject)
    .sort(
      (left, right) =>
        compareCodeUnits(left.checkerName, right.checkerName) ||
        compareCodeUnits(left.configPath, right.configPath),
    );
}

function groupProjectsByEngine(
  projects: SourceProject[],
): Map<CheckerBuildEngine, SourceProject[]> {
  const projectsByEngine = new Map<CheckerBuildEngine, SourceProject[]>();
  for (const project of projects) {
    const engine = getSourceProjectBuildEngine(project);
    const engineProjects = projectsByEngine.get(engine) ?? [];
    engineProjects.push(project);
    projectsByEngine.set(engine, engineProjects);
  }
  return projectsByEngine;
}

function selectSameEngineProvider(options: {
  providerProjects: SourceProject[];
  sameEngineProjects: SourceProject[];
}): ProviderSelectionResult | null {
  if (options.sameEngineProjects.length === 1) {
    return {
      kind: 'selected',
      project: options.sameEngineProjects[0]!,
      reason:
        'exactly one build-capable provider checker matches the consumer build engine.',
    };
  }
  if (options.sameEngineProjects.length > 1) {
    return {
      candidates: options.providerProjects,
      kind: 'ambiguous',
      reason:
        'multiple build-capable provider checkers match the consumer build engine.',
    };
  }
  return null;
}

function getProjectsForEngine(
  projectsByEngine: ReadonlyMap<CheckerBuildEngine, SourceProject[]>,
  engine: CheckerBuildEngine,
): SourceProject[] {
  return projectsByEngine.get(engine) ?? [];
}

export function selectProviderProject(options: {
  consumerProject: SourceProject;
  providerSourceFilePath: string;
  targetProjects: SourceProject[];
}): ProviderSelectionResult {
  const providerProjects = collectProviderProjects(options);
  if (providerProjects.length === 0) {
    return {
      candidates: [],
      kind: 'missing',
      reason:
        'no other build-capable checker owns the resolved provider source file.',
    };
  }
  const projectsByEngine = groupProjectsByEngine(providerProjects);
  const consumerEngine = getSourceProjectBuildEngine(options.consumerProject);
  const sameEngine = selectSameEngineProvider({
    providerProjects,
    sameEngineProjects: getProjectsForEngine(projectsByEngine, consumerEngine),
  });
  if (sameEngine) {
    return sameEngine;
  }
  return {
    candidates: providerProjects,
    kind: 'unsafe-cross-engine',
    reason:
      'only different-engine build-capable provider checkers own the resolved provider source file.',
  };
}

function isOutputBuildOwner(project: SourceProject): boolean {
  return Boolean(project.outputOptions) && isBuildCapableProject(project);
}

function addOutputBuildOwner(
  ownersBySourceConfigPath: Map<string, SourceProject[]>,
  project: SourceProject,
): void {
  const owners = ownersBySourceConfigPath.get(project.configPath) ?? [];
  owners.push(project);
  ownersBySourceConfigPath.set(project.configPath, owners);
}

function collectOutputBuildOwners(
  projects: SourceProject[],
): Map<string, SourceProject[]> {
  const ownersBySourceConfigPath = new Map<string, SourceProject[]>();
  for (const project of projects) {
    if (isOutputBuildOwner(project)) {
      addOutputBuildOwner(ownersBySourceConfigPath, project);
    }
  }
  return ownersBySourceConfigPath;
}

function formatOutputBuildOwnerCollision(options: {
  config: ResolvedLiminaConfig;
  outputBuildOwners: SourceProject[];
  sourceConfigPath: string;
}): string {
  return [
    'Output build cache boundary conflict:',
    `  config: ${toRelativePath(options.config.rootDir, options.sourceConfigPath)}`,
    `  output tsbuildinfo: ${toRelativePath(
      options.config.rootDir,
      getGeneratedOutputTsBuildInfoPath({
        packageRootDir: options.outputBuildOwners[0]!.packageRootDir,
        rootDir: options.config.rootDir,
        sourceConfigPath: options.sourceConfigPath,
      }),
    )}`,
    '  build owners:',
    ...sortSourceProjectsByChecker(options.outputBuildOwners).map(
      (project) => `    - ${formatSourceProjectWithEngine(project)}`,
    ),
    '  reason: generated output build info is keyed by source config path and is not checker-namespaced.',
    '  fix: choose one output build checker owner for this config, or split output-enabled configs so each output build boundary has one owner.',
  ].join('\n');
}

export function addOutputBuildOwnerCollisionProblems(options: {
  config: ResolvedLiminaConfig;
  problems: string[];
  projects: SourceProject[];
}): void {
  const ownersBySourceConfigPath = collectOutputBuildOwners(options.projects);
  for (const [
    sourceConfigPath,
    outputBuildOwners,
  ] of ownersBySourceConfigPath) {
    if (outputBuildOwners.length < 2) {
      continue;
    }
    options.problems.push(
      formatOutputBuildOwnerCollision({
        config: options.config,
        outputBuildOwners,
        sourceConfigPath,
      }),
    );
  }
}
