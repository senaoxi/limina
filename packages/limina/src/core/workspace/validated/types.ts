import type { MutationAuthority } from '#utils/mutation-boundary';
import type { WorkspacePackage } from '../actions';
import type {
  WorkspaceRegionBoundary,
  WorkspaceRegionTopology,
} from '../regions';

const readableTsconfigCandidateBrand: unique symbol = Symbol(
  'ReadableWorkspaceTsconfigCandidate',
);

export interface ReadableWorkspaceTsconfigCandidate {
  readonly [readableTsconfigCandidateBrand]: true;
  readonly ownerDirectory: string;
  readonly path: string;
}

export function createReadableTsconfigCandidate(options: {
  ownerDirectory: string;
  path: string;
}): ReadableWorkspaceTsconfigCandidate {
  return Object.freeze({
    [readableTsconfigCandidateBrand]: true as const,
    ownerDirectory: options.ownerDirectory,
    path: options.path,
  });
}

export function isReadableTsconfigCandidate(
  value: ReadableWorkspaceTsconfigCandidate,
): boolean {
  return value[readableTsconfigCandidateBrand] === true;
}

export type WorkspaceTsconfigOutputRootRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'output'; readonly outputRoot: string };

export type WorkspaceDescriptorKind =
  | 'package-json'
  | 'pnpm-workspace'
  | 'tsconfig';

export interface WorkspaceDescriptorCandidate {
  readonly canonicalPath: string;
  readonly displayPath: string;
  readonly kind: WorkspaceDescriptorKind;
  readonly ownerDirectory: string;
  readonly path: string;
  readonly rootDir: string;
}

export interface WorkspacePackageIdentity {
  readonly canonicalDirectory: string;
  readonly displayDirectory: string;
  readonly package: WorkspacePackage;
}

export interface WorkspacePathClassification {
  readonly boundary: WorkspaceRegionBoundary | null;
  readonly canonicalPath: string;
  readonly package: WorkspacePackage | null;
}

export interface WorkspaceOutputMutationAuthority {
  readonly authority: MutationAuthority;
  readonly declaringSourceConfig: string;
  readonly outputRoot: string;
  readonly workspaceGeneration: string;
}

export interface ValidatedWorkspaceContext extends WorkspaceRegionTopology {
  readonly configRootDir: string;
  readonly descriptorCandidates: readonly WorkspaceDescriptorCandidate[];
  readonly outputRoots: readonly string[];
  readonly outputMutationAuthorities?: ReadonlyMap<
    string,
    WorkspaceOutputMutationAuthority
  >;
  readonly packageIdentities: readonly WorkspacePackageIdentity[];
  readonly sourceConfigPaths: readonly string[];
  readonly workspaceRootDir: string;
  readonly workspaceMutationGeneration?: string;
}

export interface WorkspaceIndexMetricsRecorder {
  record(measurement: {
    readonly count?: number;
    readonly kind?: string;
    readonly name:
      | 'canonical-path-cache-hit'
      | 'canonical-path-cache-miss'
      | 'canonical-path'
      | 'provider-cache-hit'
      | 'provider-cache-miss'
      | 'workspace-directory-index-entry'
      | 'workspace-importer-ancestor-visit'
      | 'workspace-negative-lookup'
      | 'workspace-path-ancestor-visit'
      | 'workspace-path-classification-hit'
      | 'workspace-path-classification-miss';
    readonly provider?: string;
  }): void;
}
