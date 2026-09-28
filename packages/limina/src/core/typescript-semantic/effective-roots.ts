import { uniqueCodeUnitSortedStrings } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import path from 'node:path';
import ts from 'typescript';
import { parseTypeScriptProjectConfig } from './project-references';

export function isRelativeTypeName(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return value.startsWith('./') || value.startsWith('../');
}

export function resolveRelativeTypeRoots(project: {
  configPath: string;
  options: ts.CompilerOptions;
}): string[] {
  const containingFile = path.join(
    path.dirname(project.configPath),
    '__inferred type names__.ts',
  );
  return (project.options.types ?? [])
    .filter(isRelativeTypeName)
    .flatMap((name) => {
      const target = ts.resolveTypeReferenceDirective(
        name,
        containingFile,
        project.options,
        ts.sys,
      ).resolvedTypeReferenceDirective;
      return target?.resolvedFileName === undefined
        ? []
        : [normalizeAbsolutePath(target.resolvedFileName)];
    });
}

/** Explicit compiler inputs, never the transitive Program closure or ownership. */
export function getEffectiveImporterRoots(project: {
  configPath: string;
  fileNames: readonly string[];
  options: ts.CompilerOptions;
}): string[] {
  return uniqueCodeUnitSortedStrings([
    ...project.fileNames.map(normalizeAbsolutePath),
    ...resolveRelativeTypeRoots(project),
  ]);
}

export function readRelativeTypeRoots(configPath: string): string[] {
  const parsed = parseTypeScriptProjectConfig({ configPath, tsModule: ts });
  if (parsed === undefined) return [];
  return resolveRelativeTypeRoots({ configPath, options: parsed.options });
}
