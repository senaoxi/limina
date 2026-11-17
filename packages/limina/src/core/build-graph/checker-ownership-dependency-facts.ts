import type { CheckerProjectConfigCache } from '#checkers';
import type { ResolvedLiminaInputs } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { hasModuleSpecifierQueryOrFragment } from '#utils/module-specifier';
import type { DeclarationContextDecision } from '../../domain/analysis/declaration-context';
import type {
  ImportAnalysisContext,
  ImportRecord,
} from '../import-analysis/runner';
import { discoverSupplementalTarget } from '../import-analysis/supplemental-resolution';
import { shouldInferDeclarationReferenceFromImportRecord } from '../import-graph/declaration-reference-evidence';
import type { ProjectDependencyCaches } from '../project-dependencies/contracts';
import {
  getDependencyCheckerTarget,
  type ProjectDependencyEvidence,
} from '../project-dependencies/evidence';
import {
  collectProjectDependencies,
  createAutoProjectSemanticContext,
  createProjectDependencyCaches,
} from '../project-dependencies/runner';
import { TypeEvidenceCore } from '../type-evidence';
import {
  createWorkspaceSourceBoundaryFromProjects,
  type WorkspaceSourceBoundary,
} from '../typescript-semantic';
import type { AutoScopeProject } from './auto-checker-types';
import { collectCanonicalOwnerProblems } from './canonical-owner-problems';
import type { CheckerOwnershipDiscovery } from './checker-ownership-discovery';
import { uniqueFrameworkInference } from './checker-ownership-evidence';
import { collectLockedProjectFacts } from './checker-ownership-locked-facts';
import {
  createActualMembershipIndex,
  frameworkCheckerForTarget,
} from './checker-ownership-membership';
import { collectPendingOwnershipEvidence } from './checker-ownership-pending-facts';
import type {
  CheckerDependencyFact,
  TypeConfigOwnershipState,
} from './checker-ownership-types';
import { getCheckerSemanticFamily } from './checker-semantic-authority';
import type { FileOwnerLookup } from './file-owner-lookup';
import { collectIndependentCoreWork } from './independent-core-work';
import {
  freezeSemanticProject,
  prepareLockedSemanticProject,
} from './locked-semantic-project';
import { rebindSupplementalAssessments } from './locked-supplemental-assessment';

interface FactCollectionOptions {
  preparationFailures?: ReadonlyMap<string, unknown>;
  phase?: 'selection' | 'locked';
  config: ResolvedLiminaInputs;
  core: TypeEvidenceCore;
  discovery: CheckerOwnershipDiscovery;
  importAnalysis: ImportAnalysisContext;
  membership: FileOwnerLookup;
  projectDependencyCaches: ProjectDependencyCaches;
  projectConfigCache?: CheckerProjectConfigCache;
  workspaceSourceBoundary: WorkspaceSourceBoundary;
}

interface ProjectFacts {
  declarationContexts?: DeclarationContextDecision[];
  failures?: string[];
  facts: CheckerDependencyFact[];
  problems: string[];
}

function getGeneration(cache?: CheckerProjectConfigCache): number {
  return cache?.generation ?? 0;
}

function collectProjectFacts(options: {
  base: FactCollectionOptions;
  caches: ReturnType<typeof createProjectDependencyCaches>;
  project: AutoScopeProject;
}): ProjectFacts {
  const state = options.base.discovery.plan.typeConfigs.get(
    options.project.configPath,
  )!;
  if (state.semanticAuthority.kind === 'pending') {
    return collectPendingOwnershipEvidence({
      ...options.base,
      metrics: options.caches.metrics,
      onSupplementalAttempt: () => {
        if (options.caches.analysisCache)
          options.caches.analysisCache.requiresSupplementalReassessment = true;
      },
      baseline: options.caches.nativeSourceContexts?.get(
        options.project.configPath,
      ),
      project: options.project,
      state,
    });
  }
  const frozen =
    options.base.phase === 'locked'
      ? frozenProjectForCollection(options)
      : freezeSemanticProject({
          project: options.project,
          authority: state.semanticAuthority,
          projectConfigCache: options.base.projectConfigCache,
          rootDir: options.base.config.rootDir,
        });
  return collectLockedProjectFacts({
    caches: options.caches,
    config: options.base.config,
    importAnalysis: options.base.importAnalysis,
    project: frozen.project,
    state: state as TypeConfigOwnershipState & {
      semanticAuthority: Extract<
        TypeConfigOwnershipState['semanticAuthority'],
        { kind: 'locked' }
      >;
    },
    workspaceSourceBoundary: options.base.workspaceSourceBoundary,
  });
}

function frozenProjectForCollection(
  input: Parameters<typeof collectProjectFacts>[0],
) {
  const configPath = input.project.configPath;
  if (input.base.preparationFailures?.has(configPath))
    throw input.base.preparationFailures.get(configPath);
  const frozen =
    input.base.discovery.frozenProjectsByConfigPath.get(configPath);
  if (frozen === undefined)
    throw new Error(`Missing frozen semantic project for ${configPath}.`);
  return frozen;
}

function prepareFrozenProjects(
  input: Parameters<typeof collectCheckerDependencyFacts>[0],
): Map<string, unknown> {
  const failures = new Map<string, unknown>();
  for (const project of input.discovery.projectByConfigPath.values()) {
    const state = input.discovery.plan.typeConfigs.get(project.configPath)!;
    const authority = state.frozenSemanticAuthority;
    if (
      authority === undefined ||
      state.semanticAuthorityUnavailable !== undefined
    )
      continue;
    try {
      input.discovery.frozenProjectsByConfigPath.set(
        project.configPath,
        freezeSemanticProject({
          project,
          authority,
          projectConfigCache: input.projectConfigCache,
          rootDir: input.config.rootDir,
        }),
      );
    } catch (error) {
      failures.set(project.configPath, error);
    }
  }
  return failures;
}

/** Selection may inspect one normally inferred framework's own requests. Its
 * temporary collection cannot publish locked evidence or execution failures;
 * the final authority always recollects into the real Core run after freeze. */
export function collectFrameworkInferenceFacts(options: {
  config: ResolvedLiminaInputs;
  discovery: CheckerOwnershipDiscovery;
  importAnalysis: ImportAnalysisContext;
  projectConfigCache?: CheckerProjectConfigCache;
}): void {
  const boundary = createWorkspaceSourceBoundaryFromProjects(
    options.discovery.projectByConfigPath.values(),
    undefined,
    options.discovery.sourceConfigCoverage,
  );
  for (const project of options.discovery.projectByConfigPath.values()) {
    const state = options.discovery.plan.typeConfigs.get(project.configPath)!;
    const inference = uniqueFrameworkInference(state);
    if (inference === undefined || state.authoritativeOwner !== undefined)
      continue;
    const family = getCheckerSemanticFamily(inference.checker);
    if (family === 'typescript') continue;
    const files =
      family === 'vue'
        ? project.filePartition.vueFiles
        : family === 'astro'
          ? project.filePartition.astroFiles
          : project.filePartition.svelteFiles;
    if (files.length === 0) continue;
    try {
      const authority = {
        kind: 'locked',
        family,
        source: inference.source as 'config' | 'root-file' | 'dependency',
      } as const;
      const prepared = prepareLockedSemanticProject({
        project,
        authority,
        projectConfigCache: options.projectConfigCache,
        rootDir: options.config.rootDir,
      });
      const context = createAutoProjectSemanticContext({
        authority,
        project: prepared,
        workspaceSourceBoundary: boundary,
      });
      const collection = collectProjectDependencies({
        compilationObligationScope: 'generated-declaration-project-v1',
        caches: createProjectDependencyCaches(),
        context,
        importAnalysis: options.importAnalysis,
      });
      const records = [
        ...collection.dependencies,
        ...collection.failures.flatMap((failure) =>
          failure.importRecord === undefined
            ? []
            : [
                {
                  importRecord: failure.importRecord,
                  evidence: failure.evidence,
                },
              ],
        ),
        ...collection.observations.flatMap((observation) =>
          observation.kind === 'missing' ? [observation] : [],
        ),
      ];
      for (const { importRecord: record, evidence } of records)
        collectObservedFrameworkRequirement({
          ...options,
          project,
          files,
          evidence,
          record,
        });
    } catch {
      // A unique final framework reports its normal preparation failure in Core.
    }
  }
}

function collectObservedFrameworkRequirement(
  input: Parameters<typeof collectFrameworkInferenceFacts>[0] & {
    project: AutoScopeProject;
    files: readonly string[];
    evidence: ProjectDependencyEvidence;
    record: ImportRecord;
  },
): void {
  if (
    !shouldInferDeclarationReferenceFromImportRecord(input.record) ||
    hasModuleSpecifierQueryOrFragment(input.record.specifier)
  )
    return;
  const target = getDependencyCheckerTarget(input.evidence);
  if (target !== null) {
    appendObservedFrameworkRequirement(input, {
      physicalTargetPath: target.resolvedFileName,
      physicalTargetProvenance: 'checker-source',
      typeEvidenceKind: 'checker-source',
    });
    return;
  }
  // Only an authored request in this framework's actual inputs may use
  // physical discovery. Compiler-generated and support requests stay owned
  // by their existing semantic collector.
  if (
    !input.files.includes(input.record.filePath) ||
    input.record.locator.sourceStart < 0 ||
    input.record.locator.sourceEnd < 0
  )
    return;
  const discovery = (
    input.importAnalysis.resolveSupplementalImport ?? discoverSupplementalTarget
  )({
    contextId: input.project.configPath,
    requestId: JSON.stringify(input.record),
    importer: input.record.filePath,
    specifier: input.record.specifier,
    mode:
      input.record.compilerRequest?.mode === 1
        ? 1
        : input.record.compilerRequest?.mode === 99
          ? 99
          : undefined,
    configPath: input.project.configPath,
    options: input.project.options,
    extensions: input.project.context.extensions,
  });
  if (discovery.state !== 'resolved') return;
  appendObservedFrameworkRequirement(input, {
    physicalTargetPath: discovery.target,
    physicalTargetProvenance: 'pending-framework-candidate',
    typeEvidenceKind: 'unobserved',
    supplementalDiscovery: discovery,
  });
}

function appendObservedFrameworkRequirement(
  input: Parameters<typeof collectObservedFrameworkRequirement>[0],
  target: Pick<
    CheckerDependencyFact,
    | 'physicalTargetPath'
    | 'physicalTargetProvenance'
    | 'typeEvidenceKind'
    | 'supplementalDiscovery'
  > & { physicalTargetPath: string },
): void {
  const owner = input.discovery.projectByConfigPath
    .values()
    .find((project) =>
      project.filePartition.vueFiles.includes(target.physicalTargetPath),
    );
  if (frameworkCheckerForTarget(target.physicalTargetPath, owner) === undefined)
    return;
  input.discovery.plan.dependencyFacts.push({
    ...target,
    consumerConfigPath: input.project.configPath,
    importRecord: input.record,
  });
}

function collectAllProjectFacts(options: FactCollectionOptions): ProjectFacts {
  const declarationContexts: NonNullable<ProjectFacts['declarationContexts']> =
    [];
  const failures: string[] = [];
  const facts: CheckerDependencyFact[] = [];
  const problems: string[] = [];
  const projects = options.discovery.projectByConfigPath
    .values()
    .toArray()
    .sort((left, right) => compareCodeUnits(left.configPath, right.configPath));
  const caches = options.projectDependencyCaches;
  for (const project of projects) {
    const collected = collectIndependentProjectFacts({
      base: options,
      caches,
      project,
    });
    declarationContexts.push(...(collected.declarationContexts ?? []));
    failures.push(...(collected.failures ?? []));
    facts.push(...collected.facts);
    problems.push(...collected.problems);
  }
  problems.push(
    ...collectCanonicalOwnerProblems({
      facts,
      membership: options.membership,
      rootDir: options.config.rootDir,
    }),
  );
  return { facts, problems, failures, declarationContexts };
}

function collectIndependentProjectFacts(
  input: Parameters<typeof collectProjectFacts>[0],
): ProjectFacts {
  return collectIndependentCoreWork({
    caches: input.caches,
    state: input.base.discovery.plan.typeConfigs.get(input.project.configPath)!,
    phase: input.base.phase ?? 'selection',
    membership: input.base.membership,
    collect: () => collectProjectFacts(input),
  });
}

export async function collectCheckerDependencyFacts(options: {
  phase?: 'selection' | 'locked';
  config: ResolvedLiminaInputs;
  discovery: CheckerOwnershipDiscovery;
  importAnalysis: ImportAnalysisContext;
  projectDependencyCaches?: ProjectDependencyCaches;
  projectConfigCache?: CheckerProjectConfigCache;
}): Promise<string[]> {
  const preparationFailures =
    options.phase === 'locked' ? prepareFrozenProjects(options) : undefined;
  const projects =
    options.phase === 'locked'
      ? new Map(
          options.discovery.frozenProjectsByConfigPath
            .entries()
            .map(([configPath, frozen]) => [configPath, frozen.project]),
        )
      : options.discovery.projectByConfigPath;
  const membership = createActualMembershipIndex(projects);
  const workspaceSourceBoundary = createWorkspaceSourceBoundaryFromProjects(
    projects.values(),
    options.discovery.activatedRegions
      ? {
          membership,
          isWorkspaceFile: (file) =>
            options.discovery.activatedRegions!.findPackageForPath(file) !==
            null,
        }
      : undefined,
    options.discovery.sourceConfigCoverage,
  );
  const caches =
    options.projectDependencyCaches ?? createProjectDependencyCaches();
  caches.sourceConfigCoverage = options.discovery.sourceConfigCoverage;
  const core = new TypeEvidenceCore({
    analysisCache: caches.analysisCache,
    metrics: caches.metrics,
    generation: getGeneration(options.projectConfigCache),
    importAnalysis: options.importAnalysis,
    workspaceSourceBoundaryProvider: () => workspaceSourceBoundary,
  });
  try {
    const collected = collectAllProjectFacts({
      ...options,
      preparationFailures,
      core,
      membership: workspaceSourceBoundary.governance!.membership,
      projectDependencyCaches: caches,
      workspaceSourceBoundary,
    });
    if (options.phase === 'locked')
      caches.supplementalAssessments = rebindSupplementalAssessments({
        discovery: options.discovery,
        facts: collected.facts,
        importAnalysis: options.importAnalysis,
        rootDir: options.config.rootDir,
        projectConfigCache: options.projectConfigCache,
      });
    retainFactPhase(options, collected.facts);
    if (options.phase === 'locked')
      options.discovery.plan.declarationContexts =
        collected.declarationContexts;
    return collected.problems;
  } finally {
    core.dispose();
  }
}

function retainFactPhase(
  options: Parameters<typeof collectCheckerDependencyFacts>[0],
  facts: CheckerDependencyFact[],
): void {
  const plan = options.discovery.plan;
  if (options.phase === 'locked') {
    plan.ownershipSelectionFacts = structuredClone(plan.dependencyFacts);
  }
  plan.dependencyFacts = facts;
  plan.dependencyFactPhase = options.phase ?? 'selection';
}
