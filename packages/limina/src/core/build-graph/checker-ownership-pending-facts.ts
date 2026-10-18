import {
  type CheckerProjectConfigCache,
  isNativeTypeScriptProjectInput,
} from '#checkers';
import type { ResolvedLiminaInputs } from '#config/runner';
import { normalizeAbsolutePath } from '#utils/path';
import { TypeScriptConfigInputError } from '../../checker/project-base';
import type { ImportAnalysisContext } from '../import-analysis/runner';
import { shouldInferDeclarationReferenceFromImportRecord } from '../import-graph/declaration-reference-evidence';
import { configInputIdentity } from '../tsconfig/input-identity';
import type { TypeEvidenceCore } from '../type-evidence';
import type {
  TypeScriptSemanticDependencyContext,
  WorkspaceSourceBoundary,
} from '../typescript-semantic';
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

function getProgramSourceFile(
  context: TypeScriptSemanticDependencyContext,
  fileName: string,
  configPath: string,
) {
  if (context.hasSourceFile(normalizeAbsolutePath(fileName))) return;
  throw new TypeScriptConfigInputError(
    `Pending TypeScript analysis did not contain an effective source file: ${fileName}\n  config: ${configPath}\n  stage: pending-ownership-evidence`,
  );
}

function collectFileImportRecords(options: {
  context: FactCollectionContext;
  fileName: string;
}): CheckerDependencyFact['importRecord'][] {
  getProgramSourceFile(
    options.context.typeScriptSemanticContext,
    options.fileName,
    options.context.project.configPath,
  );
  return [
    ...options.context.typeScriptSemanticContext.getImportRecords(
      options.fileName,
    ),
  ];
}

function collectFileFacts(options: {
  context: FactCollectionContext;
  facts: CheckerDependencyFact[];
  fileName: string;
  problems: string[];
}): void {
  for (const importRecord of collectFileImportRecords(options)) {
    collectImportFact({ ...options, importRecord });
  }
}

function collectProjectFacts(
  options: CollectPendingOptions,
): PendingOwnershipEvidence {
  const facts: CheckerDependencyFact[] = [];
  const problems: string[] = [];
  const semantic = createEvidenceProject({
    project: options.project,
    projectConfigCache: options.projectConfigCache,
    rootDir: options.config.rootDir,
    state: options.state,
    workspaceSourceBoundary: options.workspaceSourceBoundary,
  });
  const typeScriptSemanticContext =
    options.core.getTypeScriptSemanticDependencyContext({
      checkerName: semantic.checkerName,
      project: semantic.project,
    });
  const context: FactCollectionContext = {
    ...options,
    semantic,
    typeScriptSemanticContext,
  };
  try {
    const files = contributionFiles(typeScriptSemanticContext, semantic);
    for (const fileName of files) {
      if (!isNativeTypeScriptProjectInput(fileName)) continue;
      collectFileFacts({ context, facts, fileName, problems });
    }
  } finally {
    options.core.completeProject(options.project.configPath);
  }
  return { facts, problems };
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
    adapterVersion: 'pending-typescript-v4-scope-evidence',
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
  'physicalTargetPath' | 'physicalTargetProvenance' | 'typeEvidenceKind'
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
    physicalTargetPath: candidate.targetPath,
    physicalTargetProvenance: 'pending-framework-candidate',
    typeEvidenceKind: 'missing',
  };
}

function contributionFiles(
  context: TypeScriptSemanticDependencyContext,
  semantic: EvidenceProject,
): readonly string[] {
  return context.getContributionFileNames?.() ?? semantic.project.fileNames;
}
