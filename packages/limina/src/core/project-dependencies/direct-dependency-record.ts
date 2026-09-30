import { normalizeAbsolutePath } from '#utils/path';
import type { CanonicalImportResolutionEvidence } from '../import-analysis/runner';
import {
  getResolvedTargetKind,
  isDeclarationFile,
} from '../import-graph/declaration-classifier';
import type { TypeEvidence } from '../type-evidence/cache';
import type {
  DirectSourceDependency,
  ProjectDependencyCollection,
  ProjectDependencyRequest,
} from './contracts';
import { createDirectDependencyEvidence } from './evidence';
import { createProjectDependencyFailure } from './failure';
import {
  getDirectNativeFact,
  getNativeReferenceRequirement,
  getNativeTargetPath,
  getNativeTypeEvidence,
  isCollectAmbientNativeObservation,
} from './native-dependency';
import { getDirectResolutionMode } from './resolution-mode';
import { isTypeScriptSemanticSource } from './source-evidence';

interface CollectRecordOptions {
  collection: ProjectDependencyCollection;
  importRecord: DirectSourceDependency['importRecord'];
  request: ProjectDependencyRequest;
}

type SemanticResolutionTarget = NonNullable<
  CanonicalImportResolutionEvidence['semanticEvidence']
>['target'];

function createDirectTypeEvidence(resolvedFilePath: string): TypeEvidence {
  const filePath = normalizeAbsolutePath(resolvedFilePath);
  return {
    filePath,
    kind: isDeclarationFile(filePath)
      ? 'concrete-declaration'
      : 'checker-source',
  };
}

function getDirectSemanticSpecifier(options: {
  evidence: CanonicalImportResolutionEvidence;
  importRecord: DirectSourceDependency['importRecord'];
}): string {
  return (
    options.evidence.semanticEvidence?.semanticSpecifier ??
    options.importRecord.specifier
  );
}

function createDirectDependency(options: {
  evidence: CanonicalImportResolutionEvidence;
  importRecord: DirectSourceDependency['importRecord'];
  request: ProjectDependencyRequest;
  resolvedFilePath: string;
}): DirectSourceDependency {
  const resolvedFilePath = normalizeAbsolutePath(options.resolvedFilePath);
  const nativeFact = getDirectNativeFact(options);
  const resolutionMode = getDirectResolutionMode(options);
  const typeEvidence =
    getNativeTypeEvidence(nativeFact) ??
    createDirectTypeEvidence(resolvedFilePath);
  return {
    evidence: createDirectDependencyEvidence({
      ...options,
      nativeFact,
      resolutionMode,
    }),
    nativeFact,
    referenceRequirement: getNativeReferenceRequirement(
      nativeFact,
      typeEvidence,
    ),
    importRecord: options.importRecord,
    provenance: 'direct-source',
    resolutionMode,
    resolvedFilePath,
    semanticSpecifier: getDirectSemanticSpecifier(options),
    targetKind: getResolvedTargetKind(resolvedFilePath),
    typeEvidence,
  };
}

function isNativeProjectDependencyTarget(resolvedFilePath: string): boolean {
  return [
    isDeclarationFile(resolvedFilePath),
    isTypeScriptSemanticSource(resolvedFilePath),
  ].some(Boolean);
}

function getDirectResolvedFilePath(
  options: CollectRecordOptions,
  evidence: CanonicalImportResolutionEvidence,
): string | undefined {
  const nativeFact = getDirectNativeFact(options);
  return nativeFact === undefined
    ? getDirectCheckerTargetPath(evidence)
    : getNativeTargetPath(nativeFact);
}

function getDirectCheckerTargetPath(
  evidence: CanonicalImportResolutionEvidence,
): string | undefined {
  const target =
    evidence.semanticEvidence === undefined
      ? evidence.typeScriptResolution
      : evidence.semanticEvidence.target;
  return target?.resolvedFileName;
}

function resolveDirectCheckerEvidence(options: CollectRecordOptions) {
  return options.request.importAnalysis.resolveCheckerImportEvidence(
    options.importRecord,
    options.importRecord.filePath,
    options.request.context.compilerOptions,
    {
      astroSemanticProject: options.request.context.astroSemanticProject,
      checkerPresets: [],
      configPath: options.request.context.configPath,
      extensions: [...options.request.context.extensions],
      resolverConfigPath: options.request.context.resolverConfigPath,
      semanticFamily: options.request.context.semanticAuthority.family,
      svelteSemanticProject: options.request.context.svelteSemanticProject,
      typeScriptSemanticContext: options.request.typeScriptSemanticContext,
      vueSemanticIdentity: options.request.context.vueSemanticIdentity,
    },
  );
}

function isCollectDirectFailure(options: {
  base: CollectRecordOptions;
  evidence: CanonicalImportResolutionEvidence;
}): boolean {
  const failure = options.evidence.semanticFailure;
  if (failure === undefined) return false;
  const evidence = createDirectDependencyEvidence({
    request: options.base.request,
    importRecord: options.base.importRecord,
    evidence: options.evidence,
    nativeFact: getDirectNativeFact(options.base),
    resolutionMode: getDirectResolutionMode({
      ...options.base,
      evidence: options.evidence,
    }),
  });
  options.base.collection.failures.push(
    createProjectDependencyFailure({
      evidence,
      identity: JSON.stringify(failure),
      importRecord: options.base.importRecord,
      reason: failure.reason,
      request: options.base.request,
      stage: 'module-resolution',
    }),
  );
  return true;
}

function addDirectObservation(options: {
  base: CollectRecordOptions;
  evidence: CanonicalImportResolutionEvidence;
  resolvedFilePath: string | undefined;
}): void {
  const hasResourceEvidence = [
    options.evidence.runtimeEvidence.classification === 'resource',
    options.resolvedFilePath !== undefined,
    // A raw framework lookup can explain runtime presence, never a source edge.
    options.evidence.typeScriptResolution?.resolvedBy === 'checker-source',
  ].some(Boolean);
  const resolutionMode = getDirectResolutionMode({
    ...options.base,
    evidence: options.evidence,
  });
  options.base.collection.observations.push({
    evidence: createDirectDependencyEvidence({
      request: options.base.request,
      importRecord: options.base.importRecord,
      evidence: options.evidence,
      nativeFact: getDirectNativeFact(options.base),
      resolutionMode,
    }),
    importRecord: options.base.importRecord,
    kind: hasResourceEvidence ? 'resource' : 'missing',
    resolutionMode,
  });
}

function isNativeResolvedPath(value: string | undefined): value is string {
  return value !== undefined && isNativeProjectDependencyTarget(value);
}

function hasDirectResolvedFilePath(options: {
  resolvedFilePath: string | undefined;
}): options is { resolvedFilePath: string } {
  return options.resolvedFilePath !== undefined;
}

function isCheckerSourceResolutionTarget(
  target: SemanticResolutionTarget | undefined,
): target is Exclude<SemanticResolutionTarget, null> {
  return target?.resolvedBy === 'checker-source';
}

function hasMatchingCheckerSourceTarget(options: {
  evidence: CanonicalImportResolutionEvidence;
  resolvedFilePath: string;
}): boolean {
  const target = options.evidence.semanticEvidence?.target;
  return (
    isCheckerSourceResolutionTarget(target) &&
    normalizeAbsolutePath(target.resolvedFileName) ===
      normalizeAbsolutePath(options.resolvedFilePath)
  );
}

function isCheckerSourceTarget(options: {
  evidence: CanonicalImportResolutionEvidence;
  resolvedFilePath: string | undefined;
}): options is typeof options & { resolvedFilePath: string } {
  return (
    hasDirectResolvedFilePath(options) &&
    hasMatchingCheckerSourceTarget(options)
  );
}

function isAdmittedDirectTarget(options: {
  evidence: CanonicalImportResolutionEvidence;
  resolvedFilePath: string | undefined;
}): options is typeof options & { resolvedFilePath: string } {
  return (
    isNativeResolvedPath(options.resolvedFilePath) ||
    isCheckerSourceTarget(options)
  );
}

function isAddDirectDependencyIfNative(options: {
  base: CollectRecordOptions;
  evidence: CanonicalImportResolutionEvidence;
  resolvedFilePath: string | undefined;
}): boolean {
  if (!isAdmittedDirectTarget(options)) return false;
  options.base.collection.dependencies.push(
    createDirectDependency({
      evidence: options.evidence,
      importRecord: options.base.importRecord,
      request: options.base.request,
      resolvedFilePath: options.resolvedFilePath,
    }),
  );
  return true;
}

export function collectProjectDependencyRecord(
  options: CollectRecordOptions,
): void {
  const evidence = resolveDirectCheckerEvidence(options);
  if (isCollectNonDependency(options, evidence)) return;
  const resolvedFilePath = getDirectResolvedFilePath(options, evidence);
  if (
    isAddDirectDependencyIfNative({ base: options, evidence, resolvedFilePath })
  )
    return;
  addDirectObservation({ base: options, evidence, resolvedFilePath });
}

function isCollectNonDependency(
  options: CollectRecordOptions,
  evidence: CanonicalImportResolutionEvidence,
): boolean {
  return (
    isCollectDirectFailure({ base: options, evidence }) ||
    isCollectAmbientNativeObservation({ ...options, evidence })
  );
}
