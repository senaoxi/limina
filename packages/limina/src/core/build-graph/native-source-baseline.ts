import { isNativeTypeScriptProjectInput } from '#checkers';
import { currentProfile } from '../../application/analysis/observability';
import type { SourceConfigCoverageIndex } from '../../domain/analysis/native-coverage';
import { AnalysisInputDriftError } from '../analysis-cache/contracts';
import { observeWork } from '../analysis-profile';
import type { ProjectDependencyCaches } from '../project-dependencies/contracts';
import { retainNativeObservation } from '../project-dependencies/native-evidence-retention';
import {
  createWorkspaceSourceBoundary,
  type WorkspaceSourceBoundary,
} from '../typescript-semantic';
import { createNativeDependencyContext } from '../typescript-semantic/native-context-factory';
import { observationErrorDetail } from '../typescript-semantic/native-observation-failure';
import { retainAnalysisFailure } from './analysis-failure';
import type { AutoScopeProject } from './auto-checker-types';
import { coreCollectionRun, recordCoreWork } from './core-collection-run';

export function collectUnavailableSourceDiagnostics(input: {
  coverage: SourceConfigCoverageIndex;
  unavailableProjects: readonly AutoScopeProject[];
  projectDependencyCaches?: ProjectDependencyCaches;
}): void {
  const caches = input.projectDependencyCaches;
  if (caches === undefined) return;
  caches.sourceConfigCoverage = input.coverage;
  const projects = input.unavailableProjects.filter((project) =>
    project.fileNames.some(isNativeTypeScriptProjectInput),
  );
  if (projects.length === 0) return;
  const roots = input.coverage.configurations.flatMap((entry) =>
    entry.state === 'enumerated'
      ? entry.members
          .map((member) => member.lexicalPath)
          .filter(isNativeTypeScriptProjectInput)
      : [],
  );
  const workspaceSourceBoundary = createWorkspaceSourceBoundary(
    [...roots, ...projects.flatMap((project) => project.fileNames)],
    undefined,
    input.coverage,
  );
  for (const project of projects)
    collectBaseline({
      caches,
      project,
      workspaceSourceBoundary,
    });
}

function collectBaseline(input: {
  caches: ProjectDependencyCaches;
  project: AutoScopeProject;
  workspaceSourceBoundary: WorkspaceSourceBoundary;
}): void {
  const { caches, project } = input;
  const { configPath } = project;
  const observer = currentProfile();
  const scope =
    observer &&
    ([
      'project',
      observer.project(configPath, { seenVia: 'native-baseline' }),
    ] as const);
  const item = {
    configPath,
    phase: 'baseline',
    family: 'typescript',
    eligibility: 'eligible',
  } as const;
  try {
    const snapshot = observeWork(
      observer,
      'native-baseline-context',
      () => observeBaseline(input),
      scope,
    );
    if (snapshot === undefined) return;
    retainNativeObservation(caches, snapshot);
    const failures = coreCollectionRun(caches).failureIds;
    for (const failure of snapshot.failures) failures.add(failure.id);
    recordCoreWork(caches, {
      ...item,
      execution: snapshot.run === 'completed' ? 'completed' : 'failed',
    });
  } catch (error) {
    if (error instanceof AnalysisInputDriftError) throw error;
    retainAnalysisFailure(caches, error, configPath);
    recordCoreWork(caches, {
      ...item,
      execution: 'failed',
      reason: observationErrorDetail(error),
    });
  }
}

function observeBaseline(input: Parameters<typeof collectBaseline>[0]) {
  const { project, workspaceSourceBoundary } = input;
  const context = createNativeDependencyContext({
    configPath: project.configPath,
    fileNames: project.fileNames,
    options: project.options,
    projectReferences: project.references,
    admissionMode: 'coverage-bounded',
    compilationObligationScope: 'generated-declaration-project-v1',
    analysisBinding: { phase: 'pending', checker: 'tsc' },
    virtualFiles: project.virtualFiles,
    workspaceSourceBoundary,
  });
  try {
    return context.nativeEvidence;
  } finally {
    context.dispose();
  }
}
