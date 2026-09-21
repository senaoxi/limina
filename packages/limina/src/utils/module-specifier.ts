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

/**
 * Detects `?` / `#` suffixes whose meaning belongs to a module host.
 * Limina has no host authority for that syntax and never interprets it.
 * The leading `#` of a `package.json#imports` key is not a suffix.
 */
export function hasModuleSpecifierQueryOrFragment(specifier: string): boolean {
  const body = isPackageImportSpecifier(specifier)
    ? specifier.slice(1)
    : specifier;
  return /[?#]/u.test(body);
}

/**
 * Returns the trailing extension only when the specifier is a plain path.
 * `./foo.ts?raw` and `./foo.ts#part` carry host syntax that Limina does not
 * interpret, so they have no explicit extension.
 */
export function getPlainSpecifierExtension(specifier: string): string | null {
  if (hasModuleSpecifierQueryOrFragment(specifier)) return null;
  const extension = path.extname(specifier);
  return extension.length > 0 ? extension : null;
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
