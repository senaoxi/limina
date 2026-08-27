import type { CheckerProjectConfigCache } from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import ts from 'typescript';
import type { ImportAnalysisContext } from '../import-analysis/runner';
import { collectTypeScriptSourceFileImports } from '../import-analysis/typescript-imports';
import { shouldInferDeclarationReferenceFromImportRecord } from '../import-graph/declaration-reference-evidence';
import type { TypeEvidenceCore } from '../type-evidence';
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

interface FactCollectionContext {
  config: ResolvedLiminaConfig;
  core: TypeEvidenceCore;
  discovery: CheckerOwnershipDiscovery;
  importAnalysis: ImportAnalysisContext;
  membership: ReadonlyMap<string, string[]>;
  project: AutoScopeProject;
  semantic: EvidenceProject;
  state: TypeConfigOwnershipState;
}

interface CollectPendingOptions {
  cache?: Map<string, unknown>;
  config: ResolvedLiminaConfig;
  core: TypeEvidenceCore;
  discovery: CheckerOwnershipDiscovery;
  importAnalysis: ImportAnalysisContext;
  membership: ReadonlyMap<string, string[]>;
  project: AutoScopeProject;
  projectConfigCache?: CheckerProjectConfigCache;
  state: TypeConfigOwnershipState;
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

function collectUnsupportedEvidence(options: {
  base: Omit<CheckerDependencyFact, 'typeEvidenceKind'>;
  context: FactCollectionContext;
  evidence: ReturnType<TypeEvidenceCore['resolveImportEvidence']>;
  problems: string[];
}): boolean {
  if (options.evidence.type.kind !== 'unsupported-checker') return false;
  options.problems.push(
    createUnsupportedProblem({
      config: options.context.config,
      evidence: options.evidence.type,
      fact: options.base,
    }),
  );
  return true;
}

function getCheckerSourceTarget(
  evidence: ReturnType<TypeEvidenceCore['resolveImportEvidence']>,
): PhysicalTarget | null {
  if (evidence.type.kind !== 'checker-source') return null;
  return {
    path: normalizeAbsolutePath(evidence.type.filePath),
    provenance: 'checker-source',
  };
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

function getPhysicalTarget(options: {
  context: FactCollectionContext;
  evidence: ReturnType<TypeEvidenceCore['resolveImportEvidence']>;
  importRecord: CheckerDependencyFact['importRecord'];
  problems: string[];
}): PhysicalTarget | null {
  const checkerSource = getCheckerSourceTarget(options.evidence);
  if (checkerSource !== null) return checkerSource;
  return getPendingFrameworkTarget(options);
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
  const base = {
    consumerConfigPath: options.context.project.configPath,
    importRecord: options.importRecord,
    physicalTargetPath: null,
    physicalTargetProvenance: null,
  };
  if (collectUnsupportedEvidence({ ...options, base, evidence })) return;
  if (evidence.classification === 'resource') return;
  const target = getPhysicalTarget({ ...options, evidence });
  options.facts.push(
    createDependencyFact(base, getSupportedEvidenceKind(evidence), target),
  );
}

function getSupportedEvidenceKind(
  evidence: ReturnType<TypeEvidenceCore['resolveImportEvidence']>,
): CheckerDependencyFact['typeEvidenceKind'] {
  if (evidence.type.kind === 'unsupported-checker') {
    throw new Error(
      'Unsupported checker evidence was not recorded as a problem.',
    );
  }
  return evidence.type.kind;
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

function assertTypeScriptFactFile(
  context: FactCollectionContext,
  fileName: string,
): void {
  if (context.project.filePartition.typescriptFiles.includes(fileName)) return;
  throw new Error(
    `Pending ownership evidence received a non-TypeScript source: ${fileName}`,
  );
}

function getProgramSourceFile(
  program: ts.Program,
  fileName: string,
): ts.SourceFile {
  const sourceFile = program.getSourceFile(normalizeAbsolutePath(fileName));
  if (sourceFile !== undefined) return sourceFile;
  throw new Error(
    `Pending TypeScript Program did not contain an effective source file: ${fileName}`,
  );
}

function collectFileImportRecords(options: {
  context: FactCollectionContext;
  fileName: string;
  program: ts.Program;
}): CheckerDependencyFact['importRecord'][] {
  assertTypeScriptFactFile(options.context, options.fileName);
  return collectTypeScriptSourceFileImports({
    filePath: options.fileName,
    sourceFile: getProgramSourceFile(options.program, options.fileName),
  });
}

function collectFileFacts(options: {
  context: FactCollectionContext;
  facts: CheckerDependencyFact[];
  fileName: string;
  program: ts.Program;
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
  const context: FactCollectionContext = {
    ...options,
    semantic: createEvidenceProject({
      project: options.project,
      projectConfigCache: options.projectConfigCache,
      rootDir: options.config.rootDir,
      state: options.state,
    }),
  };
  const program = ts.createProgram({
    options: context.semantic.project.options,
    projectReferences: options.project.references,
    rootNames: context.semantic.project.fileNames,
  });
  for (const fileName of options.project.filePartition.typescriptFiles) {
    collectFileFacts({ context, facts, fileName, problems, program });
  }
  options.core.completeProject(options.project.configPath);
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
    adapterVersion: 'pending-typescript-v1',
    authority: options.state.semanticAuthority,
    configPath: options.project.configPath,
    fileNames: options.project.filePartition.typescriptFiles,
    generation: options.projectConfigCache?.generation ?? 0,
    references: options.project.references,
  });
}
