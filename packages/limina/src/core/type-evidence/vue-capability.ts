import {
  isSupportedVueSemanticVersionTuple,
  type VueProjectSemanticIdentity,
} from '#checkers';
import type {
  VueTypeEvidenceCapability,
  VueTypeEvidenceVersionTuple,
} from './vue-provider-types';

export function isSupportedVueTypeEvidenceVersionTuple(
  tuple: VueTypeEvidenceVersionTuple,
): boolean {
  return isSupportedVueSemanticVersionTuple(tuple);
}

export function resolveVueTypeEvidenceCapability(
  identity: VueProjectSemanticIdentity | undefined,
): VueTypeEvidenceCapability {
  if (identity === undefined) {
    return {
      kind: 'unsupported',
      reason:
        'Vue type evidence requires a finalized Vue project semantic identity.',
    };
  }
  const { adapter, versions } = identity.toolchain;
  return adapter.kind === 'supported'
    ? { identity, kind: 'supported', versionTuple: versions }
    : {
        kind: 'unsupported',
        reason: adapter.reason,
        versionTuple: versions,
      };
}
