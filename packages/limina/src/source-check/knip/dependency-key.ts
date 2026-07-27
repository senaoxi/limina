import { normalizeAbsolutePath } from '#utils/path';

export function createPackageDependencyIssueKey(
  packageJsonPath: string,
  dependencyName: string,
): string {
  return `${normalizeAbsolutePath(packageJsonPath)}\0${dependencyName}`;
}
