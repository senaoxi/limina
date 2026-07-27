import type {
  ImportAnalysisContext,
  ImportRecord,
} from '#core/import-analysis/runner';
import type { ProjectInfo } from '#core/import-graph/context';
import {
  classifyImportRuntimeEvidence,
  type ImportRuntimeResolutionEvidence,
} from '../import-analysis/evidence';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import type { ManagedOutputDeclarationLookup } from '../import-graph/managed-output-provider';
import type { TypeEvidence } from './cache';
import type { VueTypeEvidenceCapability } from './vue-provider';

export interface ResolveImportEvidenceOptions {
  checkerName: string;
  importRecord: ImportRecord;
  managedOutputLookup?: ManagedOutputDeclarationLookup;
  project: Pick<
    ProjectInfo,
    | 'checkerPresets'
    | 'configPath'
    | 'extensions'
    | 'fileNames'
    | 'options'
    | 'resolverConfigPath'
  >;
}

export interface ResolvedImportPair {
  runtimeEvidence: ImportRuntimeResolutionEvidence;
  typeScriptResolution: ReturnType<
    ImportAnalysisContext['resolveTypeScriptImport']
  >;
}

export function resolveImportPair(options: {
  importAnalysis: ImportAnalysisContext;
  request: ResolveImportEvidenceOptions;
}): ResolvedImportPair {
  const pair = options.importAnalysis.resolveModulePair(
    options.request.importRecord.specifier,
    options.request.importRecord.filePath,
    options.request.project.options,
    options.request.project,
  );

  return {
    runtimeEvidence: classifyImportRuntimeEvidence({
      compilerOptions: options.request.project.options,
      containingFile: options.request.importRecord.filePath,
      extensions: options.request.project.extensions,
      oxcResolvedFilePath: pair.oxc,
      specifier: options.request.importRecord.specifier,
      typeScriptResolution: pair.typescript,
    }),
    typeScriptResolution: pair.typescript,
  };
}

function resolveCheckerSourceEvidence(
  resolution: ResolvedImportPair['typeScriptResolution'],
): TypeEvidence | null {
  return resolution?.resolvedBy === 'checker-source'
    ? {
        filePath: resolution.resolvedFileName,
        kind: 'checker-source',
      }
    : null;
}

function resolveManagedSource(options: {
  checkerName: string;
  filePath: string;
  lookup: ManagedOutputDeclarationLookup | undefined;
}) {
  if (options.lookup === undefined) {
    return null;
  }

  return options.lookup.resolve(options.filePath, options.checkerName);
}

type TypeScriptResolution = ResolvedImportPair['typeScriptResolution'];
type ConcreteTypeScriptResolution = NonNullable<TypeScriptResolution>;

function isDeclarationResolution(
  resolution: TypeScriptResolution,
): resolution is ConcreteTypeScriptResolution {
  return (
    resolution !== undefined &&
    resolution !== null &&
    isDeclarationFile(resolution.resolvedFileName)
  );
}

function resolveDeclarationEvidence(options: {
  request: ResolveImportEvidenceOptions;
  resolution: ResolvedImportPair['typeScriptResolution'];
}): TypeEvidence | null {
  const resolution = options.resolution;

  if (!isDeclarationResolution(resolution)) {
    return null;
  }

  const managedSource = resolveManagedSource({
    checkerName: options.request.checkerName,
    filePath: resolution.resolvedFileName,
    lookup: options.request.managedOutputLookup,
  });

  if (managedSource === null) {
    return {
      filePath: resolution.resolvedFileName,
      kind: 'concrete-declaration',
    };
  }

  return {
    filePath: resolution.resolvedFileName,
    kind: 'concrete-declaration',
    managedSource,
  };
}

export function resolveConcreteTypeEvidence(options: {
  request: ResolveImportEvidenceOptions;
  resolution: ResolvedImportPair['typeScriptResolution'];
}): TypeEvidence | null {
  return (
    resolveCheckerSourceEvidence(options.resolution) ??
    resolveDeclarationEvidence(options)
  );
}

function getEffectivePresets(
  checkerPresets: readonly string[],
): readonly string[] {
  return checkerPresets.length === 0 ? ['tsc'] : checkerPresets;
}

function isVuePreset(preset: string): boolean {
  return preset === 'vue-tsc' || preset === 'vue-tsgo';
}

function isTypeScriptPreset(preset: string): boolean {
  return preset === 'tsc' || preset === 'tsgo';
}

export function resolveTypeScriptPreset(
  checkerPresets: readonly string[],
): string | null {
  const presets = getEffectivePresets(checkerPresets);
  const hasVuePreset = presets.some(isVuePreset);

  if (hasVuePreset) {
    return null;
  }

  return presets.find(isTypeScriptPreset) ?? null;
}

export function resolveVuePreset(
  checkerPresets: readonly string[],
): string | null {
  return checkerPresets.find(isVuePreset) ?? null;
}

export function createUnsupportedCheckerEvidence(options: {
  checkerName: string;
  reason: string;
}): TypeEvidence {
  return {
    checker: options.checkerName,
    kind: 'unsupported-checker',
    reason: options.reason,
  };
}

export function createVueVersionTuple(
  capability: VueTypeEvidenceCapability,
): string[] {
  if (capability.versionTuple === undefined) {
    return [];
  }

  return [
    capability.versionTuple.vueTsc,
    capability.versionTuple.languageCore,
    capability.versionTuple.volarTypeScript,
    capability.versionTuple.typeScript,
  ];
}

export function resolveUnsupportedVueEvidence(options: {
  capability: VueTypeEvidenceCapability;
  checkerName: string;
  preset: string;
}): TypeEvidence | null {
  if (options.preset !== 'vue-tsc') {
    return createUnsupportedCheckerEvidence({
      checkerName: options.checkerName,
      reason: `Checker preset ${options.preset} does not have an approved Vue type-evidence adapter.`,
    });
  }

  if (options.capability.kind === 'unsupported') {
    return createUnsupportedCheckerEvidence({
      checkerName: options.checkerName,
      reason: options.capability.reason,
    });
  }

  return null;
}
