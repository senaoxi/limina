import type {
  ResolvedCheckerConfig,
  ResolvedLiminaConfig,
} from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import type { MutationBoundaryTarget } from '#utils/mutation-boundary';
import type ts from 'typescript';
import type { ValidatedWorkspaceContext } from '../../core/workspace/validated-context';
import type { LiminaArtifactNamespace } from '../../domain/artifacts/namespace';
import type { TypecheckTarget } from '../targets';

export interface ConfigDependencyIdentity {
  readonly canonicalPath: string;
  readonly dev: string;
  readonly hash?: string;
  readonly ino: string;
  readonly kind: 'directory' | 'file' | 'symlink';
  readonly length?: number;
  readonly linkTarget?: string;
  readonly mode?: number;
  readonly nlink?: number;
  readonly path: string;
  readonly targetDev?: string;
  readonly targetHash?: string;
  readonly targetIno?: string;
  readonly targetKind?: 'directory' | 'file';
  readonly targetLength?: number;
  readonly targetMode?: number;
  readonly targetNlink?: number;
}

export interface ParsedConfigProof {
  readonly configDependencies: readonly ConfigDependencyIdentity[];
  readonly parsed: ts.ParsedCommandLine;
}

export interface ManagedLeafClassification {
  readonly checkerName: string;
  readonly kind: 'internal-dts' | 'user-output';
  readonly sourceConfigPath: string;
}

export interface ManagedBuildStateProof {
  readonly outputPaths: readonly string[];
  readonly tsBuildInfoPath?: string;
}

export interface ProvenManagedCheckerMutationContext {
  readonly buildStateProofs: readonly ManagedBuildStateProof[];
  readonly checkerImplementationFingerprint: string;
  readonly configDependencies: readonly ConfigDependencyIdentity[];
  readonly effectiveOptionsFingerprint: string;
  readonly fingerprint: string;
  readonly inputPaths: readonly string[];
  readonly leafConfigPaths: readonly string[];
  readonly mutationTargets: readonly MutationBoundaryTarget[];
  readonly projectedOutputPaths: readonly string[];
  readonly targetId: TypecheckTarget['id'];
}

export interface ManagedMutationCoordinatorOptions {
  artifactNamespace: LiminaArtifactNamespace;
  checkers: readonly ResolvedCheckerConfig[];
  config: ResolvedLiminaConfig;
  generatedGraph: GeneratedTsconfigGraphResult;
  targets: readonly TypecheckTarget[];
  workspaceContext: ValidatedWorkspaceContext;
}

export interface ManagedLeafMutationProof {
  buildStateProof: ManagedBuildStateProof;
  configDependencies: ConfigDependencyIdentity[];
  effectiveOptionsFingerprint: string;
  inputPaths: string[];
  mutationTargets: MutationBoundaryTarget[];
  projectedOutputPaths: string[];
}

export class ManagedCheckerEmitBoundaryError extends Error {
  override readonly name = 'ManagedCheckerEmitBoundaryError';
}
