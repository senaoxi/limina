import type { ImportResolutionEvidence } from '../import-analysis/evidence';
import type { ResolveImportEvidenceOptions } from './resolution';
import { resolveManagedSource } from './resolution';

export function resolveCoreTypeEvidence(options: {
  request: ResolveImportEvidenceOptions;
  resolveProvider(): ImportResolutionEvidence;
}): ImportResolutionEvidence {
  return attributeNativeDeclarationEvidence({
    evidence: options.resolveProvider(),
    request: options.request,
  });
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
  return managedSource == null
    ? options.evidence
    : { ...options.evidence, type: { ...type, managedSource } };
}
