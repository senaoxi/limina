import type { ResolvedLiminaInputs } from '#config/runner';
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

type ProviderIdentity = Pick<
  SourceProject,
  'checkerName' | 'context' | 'ownedFileNames'
>;

export function selectProviderIdentity<T extends ProviderIdentity>(options: {
  consumerProject: ProviderIdentity;
  providerSourceFilePaths: readonly string[];
  targetProjects: readonly T[];
}):
  | { kind: 'selected'; project: T; reason: string }
  | { kind: 'missing' | 'ambiguous'; candidates: T[]; reason: string } {
  const candidates = options.targetProjects.filter(
    (project) =>
      project.checkerName !== options.consumerProject.checkerName &&
      isBuildCapableProject(project) &&
      options.providerSourceFilePaths.some((file) =>
        project.ownedFileNames.includes(file),
      ),
  );
  if (candidates.length === 1)
    return {
      kind: 'selected',
      project: candidates[0]!,
      reason:
        'exactly one build-capable checker owns the resolved provider source file.',
    };
  const sameEngine = candidates.filter(
    (project) =>
      getSourceProjectBuildEngine(project) ===
      getSourceProjectBuildEngine(options.consumerProject),
  );
  if (sameEngine.length === 1)
    return {
      kind: 'selected',
      project: sameEngine[0]!,
      reason:
        'exactly one build-capable provider checker matches the consumer build engine.',
    };
  return unselectedProvider(candidates);
}
function unselectedProvider<T>(candidates: T[]): {
  kind: 'missing' | 'ambiguous';
  candidates: T[];
  reason: string;
} {
  return {
    kind: candidates.length === 0 ? 'missing' : 'ambiguous',
    candidates,
    reason:
      candidates.length === 0
        ? 'no other build-capable checker owns the resolved provider source file.'
        : 'multiple different checker identities own the resolved provider source file.',
  };
}

export function selectProviderProject(options: {
  consumerProject: SourceProject;
  providerSourceFilePaths: readonly string[];
  targetProjects: SourceProject[];
}): ProviderSelectionResult {
  return selectProviderIdentity(options);
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
  config: ResolvedLiminaInputs;
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
  config: ResolvedLiminaInputs;
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
