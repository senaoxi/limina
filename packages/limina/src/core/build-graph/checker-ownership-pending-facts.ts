import {
  type CheckerProjectConfigCache,
  isNativeTypeScriptProjectInput,
} from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import type { ImportAnalysisContext } from '../import-analysis/runner';
import { shouldInferDeclarationReferenceFromImportRecord } from '../import-graph/declaration-reference-evidence';
import type { TypeEvidenceCore } from '../type-evidence';
import type {
  TypeScriptSemanticContext,
  WorkspaceSourceBoundary,
} from '../typescript-semantic';
import {
  hasDeclarationResolution,
  type NativeDependencyFact,
} from '../typescript-semantic/dependency-fact';
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
  config: ResolvedLiminaConfig;
  core: TypeEvidenceCore;
  discovery: CheckerOwnershipDiscovery;
  importAnalysis: ImportAnalysisContext;
  membership: FileOwnerLookup;
  project: AutoScopeProject;
  semantic: EvidenceProject;
  state: TypeConfigOwnershipState;
  workspaceSourceBoundary: WorkspaceSourceBoundary;
  typeScriptSemanticContext: TypeScriptSemanticContext;
}

interface CollectPendingOptions {
  cache?: Map<string, unknown>;
  config: ResolvedLiminaConfig;
  core: TypeEvidenceCore;
  discovery: CheckerOwnershipDiscovery;
  importAnalysis: ImportAnalysisContext;
  membership: FileOwnerLookup;
  project: AutoScopeProject;
  projectConfigCache?: CheckerProjectConfigCache;
  state: TypeConfigOwnershipState;
  workspaceSourceBoundary: WorkspaceSourceBoundary;
}

interface PhysicalTarget {
  path: string;
  provenance: CheckerDependencyFact['physicalTargetProvenance'];
}

function createUnsupportedProblem(options: {
  config: ResolvedLiminaConfig;
  evidence: Extract<
    ReturnType<TypeEvidenceCore['resolveImportEvidence']>['type'],
    { kind: 'unsupported-checker' }
  >;
  fact: Omit<CheckerDependencyFact, 'typeEvidenceKind'>;
}): string {
  return [
    'Unsupported checker type evidence:',
    `  config: ${toRelativePath(options.config.rootDir, options.fact.consumerConfigPath)}`,
    `  file: ${toRelativePath(options.config.rootDir, options.fact.importRecord.filePath)}:${options.fact.importRecord.line}`,
    `  imported specifier: ${options.fact.importRecord.specifier}`,
    `  checker: ${options.evidence.checker}`,
    `  reason: ${options.evidence.reason}`,
  ].join('\n');
}

function getPendingFrameworkTarget(options: {
  context: FactCollectionContext;
  evidence: ReturnType<TypeEvidenceCore['resolveImportEvidence']>;
  importRecord: CheckerDependencyFact['importRecord'];
  problems: string[];
}): PhysicalTarget | null {
  if (options.evidence.type.kind !== 'missing') return null;
  const candidate = resolvePendingPhysicalCandidate(options);
  if (candidate === null) return null;
  return {
    path: candidate.targetPath,
    provenance: 'pending-framework-candidate',
  };
}

// Checker-derived facts come first; runtime classification cannot cancel them.
function getPhysicalTarget(options: {
  context: FactCollectionContext;
  evidence: ReturnType<TypeEvidenceCore['resolveImportEvidence']>;
  importRecord: CheckerDependencyFact['importRecord'];
  nativeFact: NativeDependencyFact;
  problems: string[];
}): PhysicalTarget | null {
  const requirement = options.nativeFact.referenceRequirement;
  if (requirement !== null)
    return { path: requirement.targetFileName, provenance: 'checker-source' };
  if (hasDeclarationResolution(options.nativeFact.resolution)) return null;
  return getPendingFrameworkTarget(options);
}

function isRuntimeOnlyResource(
  evidence: ReturnType<TypeEvidenceCore['resolveImportEvidence']>,
  nativeFact: NativeDependencyFact,
): boolean {
  return (
    evidence.classification === 'resource' &&
    nativeFact.referenceRequirement === null &&
    !hasDeclarationResolution(nativeFact.resolution)
  );
}

function collectTypeEvidenceFact(options: {
  context: FactCollectionContext;
  facts: CheckerDependencyFact[];
  importRecord: CheckerDependencyFact['importRecord'];
  problems: string[];
}): void {
  const evidence = options.context.core.resolveImportEvidence({
    checkerName: options.context.semantic.checkerName,
    importRecord: options.importRecord,
    project: options.context.semantic.project,
    resolutionMode: 'checker-only',
  });
  const nativeFact =
    options.context.typeScriptSemanticContext.getDependencyFact(
      options.importRecord,
    );
  const base = {
    referenceRequirement: nativeFact.referenceRequirement,
    consumerConfigPath: options.context.project.configPath,
    importRecord: options.importRecord,
    physicalTargetPath: null,
    physicalTargetProvenance: null,
  };
  if (evidence.type.kind === 'unsupported-checker') {
    options.problems.push(
      createUnsupportedProblem({
        config: options.context.config,
        evidence: evidence.type,
        fact: base,
      }),
    );
    return;
  }
  if (isRuntimeOnlyResource(evidence, nativeFact)) return;
  options.facts.push(
    createDependencyFact(
      base,
      evidence.type.kind,
      getPhysicalTarget({ ...options, evidence, nativeFact }),
    ),
  );
}

function createDependencyFact(
  base: Omit<CheckerDependencyFact, 'typeEvidenceKind'>,
  typeEvidenceKind: CheckerDependencyFact['typeEvidenceKind'],
  target: PhysicalTarget | null,
): CheckerDependencyFact {
  if (target === null) return { ...base, typeEvidenceKind };
  return {
    ...base,
    physicalTargetPath: target.path,
    physicalTargetProvenance: target.provenance,
    typeEvidenceKind,
  };
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
  collectTypeEvidenceFact(options);
}

function getProgramSourceFile(
  context: TypeScriptSemanticContext,
  fileName: string,
) {
  const sourceFile = context.getSourceFile(normalizeAbsolutePath(fileName));
  if (sourceFile !== undefined) return sourceFile;
  throw new Error(
    `Pending TypeScript Program did not contain an effective source file: ${fileName}`,
  );
}

function collectFileImportRecords(options: {
  context: FactCollectionContext;
  fileName: string;
}): CheckerDependencyFact['importRecord'][] {
  getProgramSourceFile(
    options.context.typeScriptSemanticContext,
    options.fileName,
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
  const typeScriptSemanticContext = options.core.getTypeScriptSemanticContext({
    checkerName: semantic.checkerName,
    project: semantic.project,
  });
  const context: FactCollectionContext = {
    ...options,
    semantic,
    typeScriptSemanticContext,
  };
  try {
    for (const fileName of semantic.project.fileNames.filter(
      isNativeTypeScriptProjectInput,
    )) {
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
  });
}
