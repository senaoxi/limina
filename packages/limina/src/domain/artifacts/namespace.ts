export {
  ArtifactNamespaceContainmentError,
  assertArtifactNamespaceGenerationToken,
  assertArtifactPathLexicallyContained,
  assertLiminaArtifactNamespace,
  createExternalArtifactStableId,
  createLiminaArtifactNamespace,
  isArtifactPathInsideOrEqual,
  normalizeArtifactAbsolutePath,
  resolveArtifactNamespacePath,
  resolveArtifactNamespaceRelativePath,
  toArtifactNamespaceRelativePath,
} from './namespace-core';
export type {
  ArtifactNamespaceGenerationToken,
  ArtifactSafetyMetricsRecorder,
  LiminaArtifactNamespace,
} from './namespace-core';
export {
  assertArtifactPathOperationSafe,
  ensureArtifactParentDirectory,
} from './namespace-operation-safety';
export { assertArtifactPlanPathsOperationSafe } from './namespace-plan-safety';
