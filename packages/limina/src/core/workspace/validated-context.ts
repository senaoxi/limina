export { collectValidatedWorkspaceContext } from './validated/create';
export { readWorkspaceTsconfigOutputRoot } from './validated/outputs/read';
export {
  WorkspaceRegionPathIndex,
  classifyPathWithinContext,
  isPathInsideValidatedPackage,
} from './validated/path-index';
export type {
  ReadableWorkspaceTsconfigCandidate,
  ValidatedWorkspaceContext,
  WorkspaceDescriptorCandidate,
  WorkspaceDescriptorKind,
  WorkspaceIndexMetricsRecorder,
  WorkspaceOutputMutationAuthority,
  WorkspacePackageIdentity,
  WorkspacePathClassification,
  WorkspaceTsconfigOutputRootRead,
} from './validated/types';
