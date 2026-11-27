import { normalizeAbsolutePath } from '#utils/path';
import ts from 'typescript';
import type { CanonicalImportResolutionEvidence } from '../import-analysis/runner';
import type { FileDependencyFacts } from '../typescript-semantic/file-dependency-facts';
import { createImportRecordIdentity } from '../typescript-semantic/import-record';
import type {
  DirectSourceDependency,
  ProjectDependencyRequest,
} from './contracts';

const EMPTY_EXPLICIT_MODES: ReadonlyMap<string, ts.ResolutionMode> = new Map();
const explicitModesByContext = new WeakMap<
  object,
  Map<string, ReadonlyMap<string, ts.ResolutionMode>>
>();
const explicitModesByFacts = new WeakMap<
  FileDependencyFacts,
  ReadonlyMap<string, ts.ResolutionMode>
>();

function indexExplicitModes(
  facts: FileDependencyFacts | undefined,
): ReadonlyMap<string, ts.ResolutionMode> {
  if (facts === undefined) return EMPTY_EXPLICIT_MODES;
  const cached = explicitModesByFacts.get(facts);
  if (cached !== undefined) return cached;
  let modes: Map<string, ts.ResolutionMode> | undefined;
  for (const item of facts.requests) {
    if (item.explicitMode === undefined) continue;
    modes ??= new Map();
    modes.set(createImportRecordIdentity(item.occurrence), item.explicitMode);
  }
  const result = modes ?? EMPTY_EXPLICIT_MODES;
  explicitModesByFacts.set(facts, result);
  return result;
}

function getFileExplicitModes(
  request: ProjectDependencyRequest,
  filePath: string,
): ReadonlyMap<string, ts.ResolutionMode> {
  const semanticContext = request.typeScriptSemanticContext;
  if (semanticContext?.getFileDependencyFacts !== undefined) {
    let byFile = explicitModesByContext.get(semanticContext);
    if (byFile === undefined) {
      byFile = new Map();
      explicitModesByContext.set(semanticContext, byFile);
    }
    const existing = byFile.get(filePath);
    if (existing !== undefined) return existing;
    const modes = indexExplicitModes(
      semanticContext.getFileDependencyFacts(filePath),
    );
    byFile.set(filePath, modes);
    return modes;
  }
  return indexExplicitModes(request.caches?.analysisCache?.files[filePath]);
}

export function getDirectResolutionMode(options: {
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

export function getExplicitResolutionMode(options: {
  importRecord: DirectSourceDependency['importRecord'];
  request: ProjectDependencyRequest;
}): ts.ResolutionMode | undefined {
  const filePath = normalizeAbsolutePath(options.importRecord.filePath);
  const modes = getFileExplicitModes(options.request, filePath);
  return modes.size === 0
    ? undefined
    : modes.get(createImportRecordIdentity(options.importRecord));
}

function getTypeScriptResolutionMode(options: {
  importRecord: DirectSourceDependency['importRecord'];
  request: ProjectDependencyRequest;
}): ts.ResolutionMode | undefined {
  if (options.request.purpose === 'runtime-source') {
    const matched =
      options.request.typeScriptSemanticContext?.findDependencyFact?.(
        options.importRecord,
      );
    if (matched?.nativeEvidence !== undefined) {
      return matched.resolution.resolutionMode;
    }
  }
  const runtime = options.request.runtimeSourceResolver;
  return runtime === undefined
    ? semanticResolutionMode(options)
    : runtime.resolve(options.importRecord, getExplicitResolutionMode(options))
        ?.mode;
}

function semanticResolutionMode(options: {
  importRecord: DirectSourceDependency['importRecord'];
  request: ProjectDependencyRequest;
}): ts.ResolutionMode {
  return options.request.typeScriptSemanticContext?.resolveImportRecord(
    options.importRecord,
  ).resolutionMode;
}

function formatTypeScriptResolutionMode(
  mode: ts.ResolutionMode | undefined,
): string {
  if (mode === undefined) return 'default';
  return mode === ts.ModuleKind.CommonJS ? 'require' : 'import';
}
