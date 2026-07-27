import {
  LIMINA_CHECK_ISSUE_CODES,
  type LiminaWritableCheckIssueCode,
} from '../../../check-reporting/codes';

export type ReleaseSemanticIssueCode =
  | typeof LIMINA_CHECK_ISSUE_CODES.releaseContentHash
  | typeof LIMINA_CHECK_ISSUE_CODES.releasePackedManifest
  | typeof LIMINA_CHECK_ISSUE_CODES.releaseRegistry
  | typeof LIMINA_CHECK_ISSUE_CODES.releaseTarballHygiene;

export const RELEASE_SEMANTIC_ISSUE_CODES: readonly ReleaseSemanticIssueCode[] =
  [
    LIMINA_CHECK_ISSUE_CODES.releaseContentHash,
    LIMINA_CHECK_ISSUE_CODES.releasePackedManifest,
    LIMINA_CHECK_ISSUE_CODES.releaseRegistry,
    LIMINA_CHECK_ISSUE_CODES.releaseTarballHygiene,
  ] satisfies readonly LiminaWritableCheckIssueCode[];

export type ReleaseDependencySectionName =
  | 'dependencies'
  | 'devDependencies'
  | 'optionalDependencies'
  | 'peerDependencies';

export type ReleaseContentHashDiffKind =
  | 'changed'
  | 'local-only'
  | 'remote-only';

export interface ReleaseContentHashFileDiff {
  readonly kind: ReleaseContentHashDiffKind;
  readonly localHash?: string;
  readonly relativePath: string;
  readonly remoteHash?: string;
}

export interface ReleaseIgnoredContentHashDiffGroup {
  readonly diffs: readonly ReleaseContentHashFileDiff[];
  readonly ruleIdentity: string;
}

export type ReleasePackedManifestFacts =
  | {
      readonly dependencyName: string;
      readonly kind: 'output-local-specifier';
      readonly outputDirectory: string;
      readonly packageManifestPath: string;
      readonly sectionName: ReleaseDependencySectionName;
      readonly specifier: string;
    }
  | {
      readonly dependencyName: string;
      readonly importerName: string;
      readonly kind: 'source-link-dependency';
      readonly sourceManifestPath: string;
      readonly sectionName: Exclude<
        ReleaseDependencySectionName,
        'devDependencies'
      >;
      readonly specifier: string;
    }
  | {
      readonly dependencyName: string;
      readonly importerName: string;
      readonly kind: 'source-private-dependency';
      readonly sectionName: Exclude<
        ReleaseDependencySectionName,
        'devDependencies'
      >;
      readonly sourceManifestPath: string;
      readonly specifier: string;
      readonly targetManifestPath: string;
    }
  | {
      readonly dependencyName: string;
      readonly importerName: string;
      readonly kind: 'source-workspace-dependency-missing';
      readonly sectionName: Exclude<
        ReleaseDependencySectionName,
        'devDependencies'
      >;
      readonly sourceManifestPath: string;
      readonly specifier: string;
    }
  | {
      readonly dependencyName: string;
      readonly importerName: string;
      readonly kind:
        | 'packed-local-specifier'
        | 'packed-publish-local-specifier';
      readonly packedManifestPath: string;
      readonly sectionName: ReleaseDependencySectionName;
      readonly specifier: string;
    }
  | {
      readonly dependencyName: string;
      readonly importerName: string;
      readonly kind: 'packed-dependency-missing';
      readonly packedManifestPath: string;
      readonly sectionName: Exclude<
        ReleaseDependencySectionName,
        'devDependencies'
      >;
    }
  | {
      readonly actualRange: string;
      readonly dependencyName: string;
      readonly expectedVersion?: string;
      readonly importerName: string;
      readonly kind: 'packed-dependency-range-mismatch';
      readonly packedManifestPath: string;
      readonly sectionName: Exclude<
        ReleaseDependencySectionName,
        'devDependencies'
      >;
    }
  | {
      readonly kind: 'manifest-lint-failed';
      readonly lintMessage: string;
      readonly lintNode: string;
      readonly lintRule: string;
      readonly packedManifestPath: string;
    };

export type ReleaseTarballHygieneFacts =
  | {
      readonly kind: 'output-private';
      readonly packageManifestPath: string;
    }
  | {
      readonly archiveEntryPath: string;
      readonly kind: 'package-json-missing';
      readonly tarballPath: string;
    }
  | {
      readonly archiveEntryPath: string;
      readonly errorMessage: string;
      readonly kind: 'package-json-invalid';
      readonly tarballPath: string;
    }
  | {
      readonly kind: 'required-files-missing';
      readonly missingFiles: readonly string[];
      readonly tarballPath: string;
    }
  | {
      readonly archiveEntryPath: string;
      readonly kind: 'source-map-file' | 'source-mapping-url';
      readonly tarballPath: string;
    };

export type ReleaseRegistryReason =
  | 'comparison-failed'
  | 'dist-tag-missing'
  | 'integrity-invalid'
  | 'integrity-mismatch'
  | 'integrity-missing'
  | 'metadata-body-read'
  | 'metadata-http-status'
  | 'metadata-invalid-json'
  | 'metadata-invalid-object'
  | 'metadata-request'
  | 'metadata-timeout'
  | 'package-not-found'
  | 'tarball-body-read'
  | 'tarball-http-status'
  | 'tarball-request'
  | 'tarball-timeout'
  | 'tarball-url-missing'
  | 'version-missing';

export interface ReleaseRegistryFacts {
  readonly actualIntegrity?: string;
  readonly actualShasum?: string;
  readonly dependencyName: string;
  readonly errorMessage?: string;
  readonly expectedIntegrity?: string;
  readonly expectedShasum?: string;
  readonly importerName: string;
  readonly integrityField?: 'integrity' | 'shasum';
  readonly integritySource?: 'integrity' | 'shasum';
  readonly kind: ReleaseRegistryReason;
  readonly registryUrl: string;
  readonly requestedDistTag?: string;
  readonly requestedVersion?: string;
  readonly registryIntegrity?: unknown;
  readonly registryShasum?: unknown;
  readonly statusCode?: number;
  readonly statusText?: string;
  readonly tarballUrl?: string;
  readonly timeoutMs?: number;
}

export type ReleaseContentHashFacts =
  | {
      readonly configField:
        | 'release.contentHash.baselineTag'
        | 'release.contentHash.ignore';
      readonly dependencyName: string;
      readonly errorMessage: string;
      readonly importerName: string;
      readonly kind: 'config-invalid';
      readonly policy: {
        readonly baselineTag?: unknown;
        readonly builtinIgnore?: unknown;
        readonly ignore?: unknown;
      };
      readonly sourceManifestPath: string;
    }
  | {
      readonly baselineTag: string;
      readonly baselineVersion: string;
      readonly dependencyName: string;
      readonly diffs: readonly ReleaseContentHashFileDiff[];
      readonly ignoredDiffGroups: readonly ReleaseIgnoredContentHashDiffGroup[];
      readonly importerName: string;
      readonly integrity: string;
      readonly integritySource: 'integrity' | 'shasum';
      readonly kind: 'content-diff';
      readonly localOutputDirectory: string;
      readonly localVersion?: string;
      readonly sourceManifestPath: string;
      readonly tarballUrl: string;
    };

export interface ReleaseFindingFactsByCode {
  readonly [LIMINA_CHECK_ISSUE_CODES.releaseContentHash]: ReleaseContentHashFacts;
  readonly [LIMINA_CHECK_ISSUE_CODES.releasePackedManifest]: ReleasePackedManifestFacts;
  readonly [LIMINA_CHECK_ISSUE_CODES.releaseRegistry]: ReleaseRegistryFacts;
  readonly [LIMINA_CHECK_ISSUE_CODES.releaseTarballHygiene]: ReleaseTarballHygieneFacts;
}
