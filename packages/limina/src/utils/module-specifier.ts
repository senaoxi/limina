import path from 'pathe';

export function isRelativeSpecifier(specifier: string): boolean {
  return (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  );
}

export function isUrlOrDataOrFileSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith('data:') ||
    specifier.startsWith('file:') ||
    specifier.startsWith('http:') ||
    specifier.startsWith('https:')
  );
}

export function isVirtualModuleSpecifier(specifier: string): boolean {
  return specifier.startsWith('virtual:');
}

export function isPackageImportSpecifier(specifier: string): boolean {
  return specifier.startsWith('#');
}

export function isBarePackageSpecifier(specifier: string): boolean {
  return (
    !isRelativeSpecifier(specifier) &&
    !isPackageImportSpecifier(specifier) &&
    !isUrlOrDataOrFileSpecifier(specifier) &&
    !isVirtualModuleSpecifier(specifier) &&
    !path.isAbsolute(specifier)
  );
}
