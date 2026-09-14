import type { TypeScriptSemanticContext } from '../typescript-semantic';
import type { TypeEvidence } from './cache';
import {
  resolveConcreteTypeEvidence,
  type ResolvedImportPair,
  type ResolveImportEvidenceOptions,
} from './resolution';

export function resolveNativeOrConcreteEvidence(options: {
  context?: TypeScriptSemanticContext;
  request: ResolveImportEvidenceOptions;
  resolution: ResolvedImportPair['typeScriptResolution'];
}): TypeEvidence | null {
  const evidence = getNativeEvidence(options);
  if (evidence?.kind === 'ambient') return null;
  return resolveConcreteTypeEvidence(options);
}

function getNativeEvidence(options: {
  context?: TypeScriptSemanticContext;
  request: ResolveImportEvidenceOptions;
}) {
  return options.context?.getDependencyFact(options.request.importRecord)
    .typeEvidence;
}
