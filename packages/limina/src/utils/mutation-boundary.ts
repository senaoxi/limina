export {
  assertAuthorityIdentityCurrent,
  assertMutationAuthority,
  authenticateMutationAuthority,
  authorityFingerprint,
  captureTrustedBaseIdentity,
} from './mutation/authority-base';
export { assertLogicalChainSafe } from './mutation/authority-chain';
export {
  createExplicitMutationAuthority,
  createMechanicalExactMutationAuthority,
} from './mutation/authority-create';
export {
  MutationBoundaryError,
  type DirectoryMutationIdentity,
  type MissingMutationIdentity,
  type MutationAuthority,
  type MutationAuthorityScope,
  type MutationBoundarySnapshot,
  type MutationBoundarySnapshotEntry,
  type MutationBoundaryTarget,
  type MutationNodeIdentity,
  type RegularFileMutationIdentity,
  type TrustedBaseIdentity,
} from './mutation/boundary-types';
export {
  preflightMutationBoundary,
  recheckMutationBoundary,
} from './mutation/snapshot';
