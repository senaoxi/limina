export const mutationAuthorityBrand: unique symbol =
  Symbol('MutationAuthority');

export type MutationAuthorityScope = 'directory' | 'file';

interface FileSystemIdentityBase {
  readonly dev: string;
  readonly ino: string;
  readonly kind: 'directory' | 'file';
}

export interface DirectoryMutationIdentity extends FileSystemIdentityBase {
  readonly canonicalPath: string;
  readonly diagnosticNlink: number;
  readonly kind: 'directory';
}

export interface RegularFileMutationIdentity extends FileSystemIdentityBase {
  readonly hash: string;
  readonly kind: 'file';
  readonly length: number;
  readonly mode: number;
  readonly nlink: number;
}

export interface TrustedBaseIdentity {
  readonly canonicalPath: string;
  readonly canonicalTarget: {
    readonly dev: string;
    readonly ino: string;
    readonly kind: 'directory';
  };
  readonly logicalEntry: {
    readonly dev: string;
    readonly ino: string;
    readonly kind: 'directory' | 'symlink';
    readonly linkTarget?: string;
  };
}

export interface MutationAuthority {
  readonly [mutationAuthorityBrand]: true;
  readonly canonicalMutationRoot: string;
  readonly generation: string;
  readonly logicalMutationRoot: string;
  readonly scope: MutationAuthorityScope;
  readonly trustedBaseCanonicalPath: string;
  readonly trustedBaseIdentity: TrustedBaseIdentity;
  readonly trustedBaseLogicalPath: string;
}

export interface MutationBoundaryTarget {
  readonly authority: MutationAuthority;
  readonly kind: 'directory' | 'file';
  readonly path: string;
  readonly recursive?: boolean;
}

export interface MissingMutationIdentity {
  readonly canonicalProjection: string;
  readonly kind: 'missing';
  readonly path: string;
}

export type MutationNodeIdentity =
  | DirectoryMutationIdentity
  | MissingMutationIdentity
  | RegularFileMutationIdentity;

export interface MutationBoundarySnapshotEntry {
  readonly identity: MutationNodeIdentity;
  readonly path: string;
}

export interface MutationBoundarySnapshot {
  readonly authorityFingerprints: readonly string[];
  readonly entries: readonly MutationBoundarySnapshotEntry[];
  readonly fingerprint: string;
  readonly targets: readonly MutationBoundaryTarget[];
}

export class MutationBoundaryError extends Error {
  override readonly name = 'MutationBoundaryError';
}
