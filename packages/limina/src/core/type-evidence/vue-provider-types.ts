import type {
  VueProjectSemanticIdentity,
  VueSemanticVersionTuple,
} from '#checkers';

export type VueTypeEvidenceVersionTuple = VueSemanticVersionTuple;

export type VueTypeEvidenceCapability =
  | {
      kind: 'supported';
      identity: VueProjectSemanticIdentity;
      versionTuple: VueTypeEvidenceVersionTuple;
    }
  | {
      kind: 'unsupported';
      reason: string;
      versionTuple?: VueTypeEvidenceVersionTuple;
    };

export type SupportedVueTypeEvidenceCapability = Extract<
  VueTypeEvidenceCapability,
  { kind: 'supported' }
>;
