import type { CheckerProjectConfigCache } from '#checkers';
import type { ResolvedLiminaInputs } from '#config/runner';
import type { ImportAnalysisContext } from '../import-analysis/runner';
import { shouldInferDeclarationReferenceFromImportRecord } from '../import-graph/declaration-reference-evidence';
import type { TypeEvidenceCore } from '../type-evidence';
import type {
  TypeScriptSemanticDependencyContext,
  WorkspaceSourceBoundary,
} from '../typescript-semantic';
import { createTypeScriptDependencyContext } from '../typescript-semantic';
import { projectNativeDeclarationClosure } from '../typescript-semantic/native-closure';
import { isLiveNativeInventory } from '../typescript-semantic/native-context-inventory';
import type { AutoScopeProject } from './auto-checker-types';
import type { CheckerOwnershipDiscovery } from './checker-ownership-discovery';
import {
  createEvidenceProject,
  type EvidenceProject,
} from './checker-ownership-evidence-project';
import { resolvePendingPhysicalCandidate } from './checker-ownership-physical-candidate';
import type {
  CheckerDependencyFact,
  TypeConfigOwnershipState,
} from './checker-ownership-types';
import type { FileOwnerLookup } from './file-owner-lookup';
import { prepareLockedSemanticProject } from './locked-semantic-project';
import { qualifiedPendingContext } from './pending-native-context';
import { assessPendingSupplement } from './pending-supplemental-assessment';

interface PendingOwnershipEvidence {
  failures?: string[];
  facts: CheckerDependencyFact[];
  problems: string[];
}

interface FactCollectionContext {
  onSupplementalAttempt?: () => void;
  config: ResolvedLiminaInputs;
  core: TypeEvidenceCore;
  discovery: CheckerOwnershipDiscovery;
  importAnalysis: ImportAnalysisContext;
  membership: FileOwnerLookup;
  project: AutoScopeProject;
  semantic: EvidenceProject;
  state: TypeConfigOwnershipState;
  workspaceSourceBoundary: WorkspaceSourceBoundary;
  typeScriptSemanticContext: TypeScriptSemanticDependencyContext;
}

interface CollectPendingOptions {
  onSupplementalAttempt?: () => void;
  baseline?: TypeScriptSemanticDependencyContext;
  config: ResolvedLiminaInputs;
  core: TypeEvidenceCore;
  discovery: CheckerOwnershipDiscovery;
  importAnalysis: ImportAnalysisContext;
  membership: FileOwnerLookup;
  project: AutoScopeProject;
  projectConfigCache?: CheckerProjectConfigCache;
  state: TypeConfigOwnershipState;
  workspaceSourceBoundary: WorkspaceSourceBoundary;
}

function collectDependencyFact(options: {
  context: FactCollectionContext;
  facts: CheckerDependencyFact[];
  importRecord: CheckerDependencyFact['importRecord'];
  problems: string[];
}): void {
  const fact = options.context.typeScriptSemanticContext.getDependencyFact(
    options.importRecord,
  );
  const requirement = fact.referenceRequirement;
  const base = {
    nativeEvidence: fact.nativeEvidence,
    consumerConfigPath: options.context.project.configPath,
    importRecord: options.importRecord,
    referenceRequirement: requirement,
  };
  if (requirement !== null) {
    options.facts.push({
      ...base,
      physicalTargetPath: requirement.targetFileName,
      physicalTargetProvenance: 'checker-source',
      typeEvidenceKind: 'unobserved',
    });
    return;
  }
  const candidate = pendingCandidate(options, fact.resolution.target);
  options.facts.push({ ...base, ...candidate });
}

function collectImportFact(options: {
  context: FactCollectionContext;
  facts: CheckerDependencyFact[];
  importRecord: CheckerDependencyFact['importRecord'];
  problems: string[];
}): void {
  if (!shouldInferDeclarationReferenceFromImportRecord(options.importRecord)) {
    return;
  }
  collectDependencyFact(options);
}

function collectProjectFacts(
  options: CollectPendingOptions,
): PendingOwnershipEvidence {
  const failures: string[] = [];
  const facts: CheckerDependencyFact[] = [];
  const problems: string[] = [];
  const semantic = createEvidenceProject({
    project: options.project,
    projectConfigCache: options.projectConfigCache,
    rootDir: options.config.rootDir,
    state: options.state,
    workspaceSourceBoundary: options.workspaceSourceBoundary,
  });
  const typeScriptSemanticContext = pendingContext(options, semantic);
  const context: FactCollectionContext = {
    ...options,
    semantic,
    typeScriptSemanticContext,
  };
  try {
    const projection = projectNativeDeclarationClosure(
      typeScriptSemanticContext,
      {
        ...semantic.project,
        workspaceSourceBoundary: options.workspaceSourceBoundary,
      },
    );
    for (const importRecord of projection.records)
      collectImportFact({ context, facts, importRecord, problems });
    for (const failure of projection.incomplete)
      failures.push(
        `Declaration closure is incomplete (${failure.reason}): ${failure.fileName}`,
      );
  } finally {
    options.core.completeProject(options.project.configPath);
  }
  return { facts, problems, failures };
}

export function collectPendingOwnershipEvidence(
  options: CollectPendingOptions,
): PendingOwnershipEvidence {
  assertPendingAuthority(options.state);
  // Supplemental positive and negative lookups are collection-local authority.
  return collectProjectFacts(options);
}

function assertPendingAuthority(state: TypeConfigOwnershipState): void {
  if (state.semanticAuthority.kind === 'pending') return;
  throw new Error(
    'Pending ownership evidence requires a pending semantic authority.',
  );
}

function pendingCandidate(
  options: Parameters<typeof collectDependencyFact>[0],
  target: unknown,
): Pick<
  CheckerDependencyFact,
  | 'physicalTargetPath'
  | 'physicalTargetProvenance'
  | 'typeEvidenceKind'
  | 'frameworkCandidate'
  | 'supplementalCoverage'
  | 'supplementalDiscovery'
  | 'supplementalAssessment'
> {
  const empty = {
    physicalTargetPath: null,
    physicalTargetProvenance: null,
    typeEvidenceKind: 'unobserved' as const,
  };
  if (target !== null) return empty;
  const { context } = options;
  const native = context.typeScriptSemanticContext;
  const fact = native.getDependencyFact(options.importRecord);
  const requestId = fact.nativeEvidence?.requestId;
  const premises = native.nativeInventory?.modules?.find(
    (item) => item.requestId === requestId,
  );
  const resolution = native.nativeEvidence?.resolutions.find(
    (item) => item.requestId === requestId,
  );
  if (premises === undefined || resolution === undefined) return empty;
  let supplementalCoverage: CheckerDependencyFact['supplementalCoverage'];
  let supplementalDiscovery: CheckerDependencyFact['supplementalDiscovery'];
  const candidate = resolvePendingPhysicalCandidate({
    ...options,
    premises,
    onDiscovery: (value, coverage) => {
      supplementalCoverage = coverage;
      supplementalDiscovery = value;
      context.onSupplementalAttempt?.();
    },
  });
  if (candidate === null)
    return { ...empty, supplementalDiscovery, supplementalCoverage };
  const result: ReturnType<typeof pendingCandidate> = {
    frameworkCandidate: candidate,
    physicalTargetPath: candidate.targetPath,
    physicalTargetProvenance: 'pending-framework-candidate',
    typeEvidenceKind: 'unobserved',
    supplementalDiscovery,
    supplementalCoverage,
  };
  if (supplementalDiscovery === undefined || candidate.family !== 'vue')
    return result;
  const owner = context.discovery.projectByConfigPath.get(
    candidate.owningConfigPath,
  )?.context.vueSemanticIdentity;
  if (owner === undefined) return result;
  const consumer = prepareLockedSemanticProject({
    project: context.project,
    authority: { kind: 'locked', family: 'vue', source: 'dependency' },
    rootDir: context.config.rootDir,
  }).context.vueSemanticIdentity;
  if (consumer === undefined) return result;
  result.supplementalAssessment = assessPendingSupplement({
    baseline: native.nativeEvidence!.contexts[0]!,
    emitOptions: context.semantic.project.options,
    occurrence: options.importRecord,
    premises,
    discovery: supplementalDiscovery,
    coverage: candidate.coverage,
    owner,
    consumer,
    importer: options.importRecord.filePath,
    specifier: options.importRecord.specifier,
    roots: native.nativeInventory!.roots.map((item) => item.root),
  });
  return result;
}

function pendingContext(
  options: CollectPendingOptions,
  semantic: EvidenceProject,
): TypeScriptSemanticDependencyContext {
  const context =
    qualifiedPendingContext(options.baseline, {
      ...semantic.project,
      workspaceSourceBoundary: options.workspaceSourceBoundary,
    }) ??
    options.core.getTypeScriptSemanticDependencyContext({
      checkerName: semantic.checkerName,
      project: semantic.project,
    });
  return isLiveNativeInventory(context.nativeInventory)
    ? context
    : createTypeScriptDependencyContext({
        ...semantic.project,
        workspaceSourceBoundary: options.workspaceSourceBoundary,
        admissionMode: 'coverage-bounded',
      });
}
