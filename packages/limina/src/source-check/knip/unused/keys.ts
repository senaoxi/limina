import { normalizeAbsolutePath } from '#utils/path';
import type { PackageOwnerIdentity } from '../../../core/workspace/owner-identity';

export function createOwnerSourceFileKey(
  ownerIdentity: PackageOwnerIdentity,
  filePath: string,
): string {
  return `${ownerIdentity}\0${normalizeAbsolutePath(filePath)}`;
}
