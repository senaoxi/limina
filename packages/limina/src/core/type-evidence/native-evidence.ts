import type { ImportResolutionEvidence } from '../import-analysis/evidence';
import type {
  ResolvedImportPair,
  ResolveImportEvidenceOptions,
} from './resolution';
import {
  resolveConcreteTypeEvidence,
  resolveManagedSource,
} from './resolution';

export function resolveCoreTypeEvidence(options: {
  native: boolean;
  pair: ResolvedImportPair;
  request: ResolveImportEvidenceOptions;
  resolveProvider(): ImportResolutionEvidence;
}): ImportResolutionEvidence {
  if (options.native)
    return attributeNativeDeclarationEvidence({
      evidence: options.resolveProvider(),
      request: options.request,
    });
  const concrete = resolveConcreteTypeEvidence({
    request: options.request,
    resolution: options.pair.typeScriptResolution,
  });
  return concrete === null
    ? options.resolveProvider()
    : { ...options.pair.runtimeEvidence, type: concrete };
}

export function attributeNativeDeclarationEvidence(options: {
  evidence: ImportResolutionEvidence;
  request: ResolveImportEvidenceOptions;
}): ImportResolutionEvidence {
  const type = options.evidence.type;
  if (type.kind !== 'concrete-declaration') return options.evidence;
  const managedSource = resolveManagedSource({
    checkerName: options.request.checkerName,
    filePath: type.filePath,
    lookup: options.request.managedOutputLookup,
  });
  if (managedSource == null) return options.evidence;
  return { ...options.evidence, type: { ...type, managedSource } };
}
