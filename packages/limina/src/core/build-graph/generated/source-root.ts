import path from 'pathe';
import type { SourceProject } from '../types';
function isSameOrParentDirectory(
  parentDirectory: string,
  childDirectory: string,
): boolean {
  const relativePath = path.relative(parentDirectory, childDirectory);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  );
}

function isContainsAllDirectories(
  parentDirectory: string,
  childDirectories: string[],
): boolean {
  return childDirectories.every((childDirectory) =>
    isSameOrParentDirectory(parentDirectory, childDirectory),
  );
}

function findCommonDirectory(
  initialDirectory: string,
  fileDirectories: string[],
): string {
  let commonDirectory = initialDirectory;
  while (!isContainsAllDirectories(commonDirectory, fileDirectories)) {
    const parentDirectory = path.dirname(commonDirectory);
    if (parentDirectory === commonDirectory) {
      return commonDirectory;
    }
    commonDirectory = parentDirectory;
  }
  return commonDirectory;
}

export function getCommonSourceRootDirectory(project: SourceProject): string {
  const fileDirectories = project.fileNames.map((fileName) =>
    path.dirname(fileName),
  );
  return fileDirectories.length === 0
    ? path.dirname(project.configPath)
    : findCommonDirectory(fileDirectories[0]!, fileDirectories);
}
