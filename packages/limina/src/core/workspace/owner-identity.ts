import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import type {
  ValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from './validated-context';
import { canonicalProjectedPathSync } from './validated/shared';

declare const packageOwnerIdentityBrand: unique symbol;
export type PackageOwnerIdentity = string & {
  readonly [packageOwnerIdentityBrand]: true;
};

/** Only an already validated canonical package identity can become an owner key. */
export function getPackageOwnerIdentity(
  context: ValidatedWorkspaceContext,
  directory: string,
): PackageOwnerIdentity {
  const normalized = normalizeAbsolutePath(directory);
  const identity = context.packageIdentities.find(
    (entry) =>
      entry.package.directory === normalized ||
      entry.canonicalDirectory === normalized,
  );
  if (identity === undefined)
    throw new Error(`No validated package owner at ${directory}.`);
  return identity.canonicalDirectory as PackageOwnerIdentity;
}

/** Knip paths are provenance inputs; resolve them against validated owners first. */
export function findPackageOwnerIdentity(
  context: ValidatedWorkspaceContext,
  manifestPath: string,
): PackageOwnerIdentity | undefined {
  if (path.basename(manifestPath) !== 'package.json') return undefined;
  // The manifest may itself be a symlink; its target does not relocate the package owner.
  const normalized = canonicalProjectedPathSync(path.dirname(manifestPath));
  const identity = context.packageIdentities.find(
    (entry) => entry.canonicalDirectory === normalized,
  );
  return identity?.canonicalDirectory as PackageOwnerIdentity | undefined;
}
/** Keep source provenance on the validated owner's retained lexical path. */
export function projectToPackageOwnerPath(
  pathIndex: WorkspaceRegionPathIndex,
  filePath: string,
): string | null {
  const classification = pathIndex.classifyPath(filePath);
  const owner = classification.package;
  if (owner === null) return null;
  const canonicalOwner = pathIndex.classifyPath(owner.directory).canonicalPath;
  return normalizeAbsolutePath(
    path.join(
      owner.directory,
      path.relative(canonicalOwner, classification.canonicalPath),
    ),
  );
}
