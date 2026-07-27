import { normalizeAbsolutePath } from '#utils/path';

export function createOwnerSourceFileKey(
  ownerName: string,
  filePath: string,
): string {
  return `${ownerName}\0${normalizeAbsolutePath(filePath)}`;
}
