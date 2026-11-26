import { uniqueCodeUnitSortedStrings } from '#utils/collections';
import { isRelativeSpecifier } from '#utils/module-specifier';
import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
export function isRelativeTypeName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    isRelativeSpecifier(value.replaceAll('\\', '/'))
  );
}

export function getEffectiveImporterRoots(project: {
  configPath: string;
  fileNames: readonly string[];
  options: ts.CompilerOptions;
}): string[] {
  return uniqueCodeUnitSortedStrings(
    project.fileNames.map(normalizeAbsolutePath),
  );
}
