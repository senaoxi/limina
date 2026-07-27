import path from 'pathe';

const relativeSpecifiers = new Set(['.', '..']);
const urlLikePrefixes = ['data:', 'file:', 'http:', 'https:'];

function hasAnyPrefix(value: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

export function isRelativeSpecifier(specifier: string): boolean {
  return (
    relativeSpecifiers.has(specifier) || hasAnyPrefix(specifier, ['./', '../'])
  );
}

export function isUrlOrDataOrFileSpecifier(specifier: string): boolean {
  return hasAnyPrefix(specifier, urlLikePrefixes);
}

export function isVirtualModuleSpecifier(specifier: string): boolean {
  return specifier.startsWith('virtual:');
}

export function isPackageImportSpecifier(specifier: string): boolean {
  return specifier.startsWith('#');
}

function isNonBareSpecifier(specifier: string): boolean {
  const classifiers = [
    isRelativeSpecifier,
    isPackageImportSpecifier,
    isUrlOrDataOrFileSpecifier,
    isVirtualModuleSpecifier,
    path.isAbsolute,
  ];

  return classifiers.some((classify) => classify(specifier));
}

export function isBarePackageSpecifier(specifier: string): boolean {
  return !isNonBareSpecifier(specifier);
}
