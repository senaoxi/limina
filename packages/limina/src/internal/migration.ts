// Version-locked support for limina-migrate. Not a cross-version extension API.
export { createElapsedTimer } from 'logaria/helper';
export {
  ReplacementDriftError,
  RetryableReplacementValidationIoError,
  TerminalReplacementValidationError,
  replaceFileWithRetry,
  writeJsonAtomically,
} from '../check-reporting/atomic-writer';
export { LiminaStructuredError } from '../check-reporting/errors';
export { TypeScriptConfigInputError } from '../checker/project-base';
export { parseCheckerProjectConfigForContext } from '../checkers';
export { createCliFlow, runCliFlowWithCleanup } from '../cli/flow';
export { parseConfigLoader } from '../cli/parse';
export {
  loadConfig,
  type RegionExcludeConfig,
  type ResolvedLiminaConfig,
} from '../config/runner';
export {
  readImplicitRefs,
  readOutputOptions,
} from '../core/build-graph/generated/config-readers';
export { capabilityDiscoveryExtensions } from '../core/build-graph/generated/file-extensions';
export {
  readInputTopology,
  type InputTopologyResult,
} from '../core/build-graph/input-topology';
export { analyzeProjectDependencies } from '../core/build-graph/prepare';
export { type DependencyAnalysisResult } from '../core/build-graph/types';
export { type ReferencePathInfo } from '../core/tsconfig/action-types';
export {
  collectReferencePathInfosFromConfigObject,
  createLiminaTsconfigSchemaPath,
  isLiminaSolutionConfig,
  isOrdinarySourceTypecheckConfigPath,
  isTypeScriptSolutionConfig,
  readJsonConfig,
  resolveReferencePath,
  validateUserMaintainedLiminaTsconfigMetadata,
  type JsonObject,
} from '../core/tsconfig/actions';
export { TsconfigInputError } from '../core/tsconfig/config-paths';
export { collectRawWorkspacePackages } from '../core/workspace/actions';
export {
  WorkspaceRegionPathIndex,
  collectValidatedWorkspaceContext,
  collectWorkspaceInputSnapshot,
} from '../core/workspace/validated-context';
export { resolveStableDescriptors } from '../core/workspace/validated/descriptors/stability';
export { excludeTsconfigDescriptors } from '../core/workspace/validated/exclusions';
export { collectOutputDeclarations } from '../core/workspace/validated/outputs/collection';
export { validateOutputRoot } from '../core/workspace/validated/outputs/validation';
export { type LiminaArtifactNamespace } from '../domain/artifacts/namespace';
export { LiminaFlowReporter } from '../flow';
export { MigrationLogger, clearCliScreen, formatErrorMessage } from '../logger';
export {
  resolvePreflight,
  type LiminaPreflightManager,
  type PreflightCapableOptions,
} from '../preflight';
export { isPathInsideDirectory, normalizeAbsolutePath } from '../utils/path';
export { collectStronglyConnectedComponents } from '../utils/strongly-connected-components';
export { isPlainRecord } from '../utils/values';
