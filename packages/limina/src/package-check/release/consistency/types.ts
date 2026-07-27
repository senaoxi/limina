import type {
  ReleaseContentHashConfigArgs,
  ResolvedLiminaConfig,
} from '#config/runner';
import type {
  NamedWorkspacePackage,
  PublishDependencySectionName,
  WorkspacePackage,
} from '#core/workspace/actions';
import type { ReleaseContentHashFileDiff } from '../findings/facts';
import type { ReleaseFinding } from '../findings/types';

export interface PublishDependencyEntry {
  dependencyName: string;
  sectionName: PublishDependencySectionName;
  specifier: string;
}

export type PackageDependencySectionName =
  | PublishDependencySectionName
  | 'devDependencies';

export interface PackageDependencyEntry {
  dependencyName: string;
  sectionName: PackageDependencySectionName;
  specifier: string;
}

export interface PublishManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  private?: boolean;
  version?: string;
}

export interface PackedPackageFile {
  data: Uint8Array;
  name: string;
}

export interface PackedPackage {
  files: PackedPackageFile[];
  rootDir: string;
}

export interface PackedPackageContentFile {
  data: Uint8Array;
  relativePath: string;
}

export const CONTENT_HASH_DIFF_KINDS = [
  'local-only',
  'remote-only',
  'changed',
] as const;

export type ContentHashDiffKind = (typeof CONTENT_HASH_DIFF_KINDS)[number];

export interface PackedArtifactContent {
  filesByPath: Map<string, PackedPackageContentFile>;
  packageVersion: string | null;
}

export type ContentHashDiff = ReleaseContentHashFileDiff;
export type ContentHashDiffGroup = Record<
  ContentHashDiffKind,
  ContentHashDiff[]
>;

export interface ContentHashIgnoreRule {
  label: string;
  matches: (relativePath: string) => boolean;
}

export interface IgnoredContentHashDiffGroup {
  diffs: ContentHashDiffGroup;
  label: string;
}

export interface WorkspacePackageOutputComparison {
  ignoredDiffGroups: IgnoredContentHashDiffGroup[];
  localOutputDirectory: string;
  localVersion: string | null;
  matchesBaseline: boolean;
  releaseRelevantDiffs: ContentHashDiffGroup;
}

export interface RegistryDistMetadata {
  integrity?: unknown;
  shasum?: unknown;
  tarball?: unknown;
}

export interface RegistryVersionMetadata {
  dist?: RegistryDistMetadata;
}

export interface RegistryPackageMetadata {
  'dist-tags'?: unknown;
  versions?: unknown;
}

export type RegistryMetadataResult =
  | { kind: 'found'; metadata: RegistryPackageMetadata }
  | { kind: 'missing'; statusCode: 404; url: string }
  | {
      cause?: unknown;
      kind: 'failure';
      reason:
        | 'body-read'
        | 'http-status'
        | 'invalid-json'
        | 'invalid-metadata'
        | 'request'
        | 'timeout';
      statusCode?: number;
      statusText?: string;
      timeoutMs?: number;
      url: string;
    };

export type RegistryTarballIntegrityResult =
  | {
      expectedShasum?: string;
      integrity: string;
      kind: 'found';
      registryIntegrity?: unknown;
      registryShasum?: unknown;
      source: 'integrity' | 'shasum';
    }
  | {
      field: 'integrity' | 'shasum';
      kind: 'invalid';
      registryIntegrity?: unknown;
      registryShasum?: unknown;
    }
  | { kind: 'missing' };

export interface RegistryTarballFailure {
  actualIntegrity?: string;
  actualShasum?: string;
  errorMessage?: string;
  expectedIntegrity?: string;
  expectedShasum?: string;
  kind:
    | 'integrity-mismatch'
    | 'tarball-body-read'
    | 'tarball-http-status'
    | 'tarball-request'
    | 'tarball-timeout';
  statusCode?: number;
  statusText?: string;
  tarballUrl: string;
  timeoutMs?: number;
}

export class RegistryTarballError extends Error {
  override readonly name = 'RegistryTarballError';
  readonly failure: RegistryTarballFailure;

  constructor(failure: RegistryTarballFailure, message: string) {
    super(message);
    this.failure = failure;
  }
}

export interface DirectWorkspaceDependency {
  dependencyName: string;
  sectionName: PublishDependencySectionName;
  targetPackage: NamedWorkspacePackage;
}

export interface ReleaseConsistencyState {
  changedPackageNames: Set<string>;
  directWorkspaceDependencies: DirectWorkspaceDependency[];
  edges: Map<string, Set<string>>;
  findings: ReleaseFinding[];
  registryMetadataCache: Map<string, RegistryMetadataResult>;
  unpublishedPackageNames: Set<string>;
  visitedPackages: Set<string>;
}

export interface AssertPackageReleaseConsistencyOptions {
  config: ResolvedLiminaConfig;
  label: string;
  outputManifest: PublishManifest;
  packedTarballPath: string;
  packedTarball: Buffer;
  outDir: string;
  workspacePackages: readonly WorkspacePackage[];
}

export interface ContentHashContext {
  baselineTag: string;
  config: ReleaseContentHashConfigArgs | undefined;
}
