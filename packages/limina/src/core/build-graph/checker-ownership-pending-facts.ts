import type { CheckerProjectConfigCache } from '#checkers';
import type { ResolvedLiminaInputs } from '#config/runner';
import type { ImportAnalysisContext } from '../import-analysis/runner';
import { shouldInferDeclarationReferenceFromImportRecord } from '../import-graph/declaration-reference-evidence';
import { configInputIdentity } from '../tsconfig/input-identity';
import type { TypeEvidenceCore } from '../type-evidence';
import type {
  TypeScriptSemanticDependencyContext,
  WorkspaceSourceBoundary,
} from '../typescript-semantic';
import { projectNativeDeclarationClosure } from '../typescript-semantic/native-closure';
import type { AutoScopeProject } from './auto-checker-types';
import type { CheckerOwnershipDiscovery } from './checker-ownership-discovery';
import {
  createEvidenceProject,
  type EvidenceProject,
} from './checker-ownership-evidence-project';
import {
  getCachedPendingEvidence,
  type PendingOwnershipEvidence,
  storePendingEvidence,
} from './checker-ownership-pending-cache';
import { resolvePendingPhysicalCandidate } from './checker-ownership-physical-candidate';
import type {
  CheckerDependencyFact,
  TypeConfigOwnershipState,
} from './checker-ownership-types';
import type { FileOwnerLookup } from './file-owner-lookup';
import { qualifiedPendingContext } from './pending-native-context';

interface FactCollectionContext {
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
  baseline?: TypeScriptSemanticDependencyContext;
  cache?: Map<string, unknown>;
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
  // The inventory still owns support-file absence proofs. Checker selection
  // needs root occurrences, real obligations and physical framework candidates,
  // not a second copy of every standard-library directive.
  if (
    candidate.physicalTargetPath === null &&
    !options.context.project.fileNames.includes(options.importRecord.filePath)
  )
    return;
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
  const cacheKey = createPendingCacheKey(options);
  const cached = getCachedPendingEvidence({ cache: options.cache, cacheKey });
  if (cached !== undefined) return cached;
  const collected = collectProjectFacts(options);
  storePendingEvidence({ cache: options.cache, cacheKey, evidence: collected });
  return collected;
}

function assertPendingAuthority(state: TypeConfigOwnershipState): void {
  if (state.semanticAuthority.kind === 'pending') return;
  throw new Error(
    'Pending ownership evidence requires a pending semantic authority.',
  );
}

function createPendingCacheKey(options: CollectPendingOptions): string {
  return JSON.stringify({
    adapterVersion: 'pending-typescript-v6-declaration-governance',
    boundary: options.workspaceSourceBoundary.identity,
    authority: options.state.semanticAuthority,
    configPath: options.project.configPath,
    fileNames: options.project.filePartition.typescriptFiles,
    generation: options.projectConfigCache?.generation ?? 0,
    references: options.project.references,
    virtualFiles: configInputIdentity(options.project.virtualFiles),
  });
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
> {
  const candidate =
    target === null ? resolvePendingPhysicalCandidate(options) : null;
  if (candidate === null)
    return {
      physicalTargetPath: null,
      physicalTargetProvenance: null,
      typeEvidenceKind: 'unobserved',
    };
  return {
    frameworkCandidate: candidate,
    physicalTargetPath: candidate.targetPath,
    physicalTargetProvenance: 'pending-framework-candidate',
    typeEvidenceKind: 'missing',
  };
}

function pendingContext(
  options: CollectPendingOptions,
  semantic: EvidenceProject,
): TypeScriptSemanticDependencyContext {
  return (
    qualifiedPendingContext(options.baseline, {
      ...semantic.project,
      workspaceSourceBoundary: options.workspaceSourceBoundary,
    }) ??
    options.core.getTypeScriptSemanticDependencyContext({
      checkerName: semantic.checkerName,
      project: semantic.project,
    })
  );
}
