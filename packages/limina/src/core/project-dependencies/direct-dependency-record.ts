import { normalizeAbsolutePath } from '#utils/path';
import ts from 'typescript';
import type { CanonicalImportResolutionEvidence } from '../import-analysis/runner';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import type { TypeEvidence } from '../type-evidence/cache';
import type {
  DirectSourceDependency,
  ProjectDependencyCollection,
  ProjectDependencyRequest,
} from './contracts';
import { createProjectDependencyFailure } from './failure';
import { isTypeScriptSemanticSource } from './source-evidence';

interface CollectRecordOptions {
  collection: ProjectDependencyCollection;
  importRecord: DirectSourceDependency['importRecord'];
  request: ProjectDependencyRequest;
}

type SemanticResolutionTarget = NonNullable<
  CanonicalImportResolutionEvidence['semanticEvidence']
>['target'];

function getTargetKind(
  resolvedFilePath: string,
): DirectSourceDependency['targetKind'] {
  return isDeclarationFile(resolvedFilePath) ? 'declaration' : 'source';
}

function createDirectTypeEvidence(resolvedFilePath: string): TypeEvidence {
  const filePath = normalizeAbsolutePath(resolvedFilePath);
  return isDeclarationFile(filePath)
    ? { filePath, kind: 'concrete-declaration' }
    : { filePath, kind: 'checker-source' };
}

function getDirectResolutionMode(options: {
  evidence: CanonicalImportResolutionEvidence;
  importRecord: DirectSourceDependency['importRecord'];
  request: ProjectDependencyRequest;
}): string {
  const frameworkMode = getFrameworkResolutionMode(options.evidence);
  if (frameworkMode !== undefined) return frameworkMode;
  const mode = getTypeScriptResolutionMode(options);
  return formatTypeScriptResolutionMode(mode);
}

function getFrameworkResolutionMode(
  evidence: CanonicalImportResolutionEvidence,
): string | undefined {
  return evidence.semanticEvidence?.resolutionMode;
}

function getTypeScriptResolutionMode(options: {
  importRecord: DirectSourceDependency['importRecord'];
  request: ProjectDependencyRequest;
}): ts.ResolutionMode | undefined {
  return options.request.typeScriptSemanticContext?.resolveImportRecord(
    options.importRecord,
  ).resolutionMode;
}

function formatTypeScriptResolutionMode(
  mode: ts.ResolutionMode | undefined,
): string {
  if (mode === undefined) return 'default';
  if (mode === ts.ModuleKind.CommonJS) return 'require';
  return 'import';
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
  return {
    importRecord: options.importRecord,
    provenance: 'direct-source',
    resolutionMode: getDirectResolutionMode(options),
    resolvedFilePath,
    semanticSpecifier: getDirectSemanticSpecifier(options),
    targetKind: getTargetKind(resolvedFilePath),
    typeEvidence: createDirectTypeEvidence(resolvedFilePath),
  };
}

function isNativeProjectDependencyTarget(resolvedFilePath: string): boolean {
  return [
    isDeclarationFile(resolvedFilePath),
    isTypeScriptSemanticSource(resolvedFilePath),
  ].some(Boolean);
}

function normalizeWorkspaceResolution(
  resolvedFilePath: string | null,
): string | undefined {
  return resolvedFilePath === null ? undefined : resolvedFilePath;
}

function getWorkspaceTypeScriptResolution(
  options: CollectRecordOptions,
): string | undefined {
  if (options.request.context.semanticAuthority.family !== 'typescript') {
    return undefined;
  }
  const resolve = options.request.resolveWorkspaceTypeScriptExport;
  return resolve === undefined
    ? undefined
    : normalizeWorkspaceResolution(resolve(options.importRecord.specifier));
}

function getDirectResolvedFilePath(
  options: CollectRecordOptions,
  evidence: CanonicalImportResolutionEvidence,
): string | undefined {
  const checkerResolution = [
    getSemanticResolvedFilePath(evidence),
    getTypeScriptResolvedFilePath(evidence),
  ].find((value): value is string => value !== undefined);
  if (checkerResolution !== undefined) return checkerResolution;
  return getWorkspaceTypeScriptResolution(options);
}

function getSemanticResolvedFilePath(
  evidence: CanonicalImportResolutionEvidence,
): string | undefined {
  return evidence.semanticEvidence?.target?.resolvedFileName;
}

function getTypeScriptResolvedFilePath(
  evidence: CanonicalImportResolutionEvidence,
): string | undefined {
  return evidence.typeScriptResolution?.resolvedFileName;
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

function collectDirectFailure(options: {
  base: CollectRecordOptions;
  evidence: CanonicalImportResolutionEvidence;
}): boolean {
  const failure = options.evidence.semanticFailure;
  if (failure === undefined) return false;
  options.base.collection.failures.push(
    createProjectDependencyFailure({
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
  ].some(Boolean);
  options.base.collection.observations.push({
    importRecord: options.base.importRecord,
    kind: hasResourceEvidence ? 'resource' : 'missing',
  });
}

function isNativeResolvedPath(value: string | undefined): value is string {
  if (value === undefined) return false;
  return isNativeProjectDependencyTarget(value);
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
  if (!isCheckerSourceResolutionTarget(target)) return false;
  return (
    normalizeAbsolutePath(target.resolvedFileName) ===
    normalizeAbsolutePath(options.resolvedFilePath)
  );
}

function isCheckerSourceTarget(options: {
  evidence: CanonicalImportResolutionEvidence;
  resolvedFilePath: string | undefined;
}): options is typeof options & { resolvedFilePath: string } {
  if (!hasDirectResolvedFilePath(options)) return false;
  return hasMatchingCheckerSourceTarget(options);
}

function isAdmittedDirectTarget(options: {
  evidence: CanonicalImportResolutionEvidence;
  resolvedFilePath: string | undefined;
}): options is typeof options & { resolvedFilePath: string } {
  if (isNativeResolvedPath(options.resolvedFilePath)) return true;
  return isCheckerSourceTarget(options);
}

function addDirectDependencyIfNative(options: {
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
  if (collectDirectFailure({ base: options, evidence })) return;
  const resolvedFilePath = getDirectResolvedFilePath(options, evidence);
  if (
    addDirectDependencyIfNative({ base: options, evidence, resolvedFilePath })
  )
    return;
  addDirectObservation({ base: options, evidence, resolvedFilePath });
}
