import { isPlainRecord } from '#utils/values';
import type { DistPackageJson, SelfSpecifierMatchers } from './manifest-types';

function nonEmptySubpath(value: string): string | null {
  return value.length === 0 ? null : value;
}

function normalizeExportSubpath(exportKey: string): string | null {
  if (exportKey === '.') {
    return '';
  }

  if (!exportKey.startsWith('./')) {
    return null;
  }

  return nonEmptySubpath(exportKey.slice('./'.length));
}

function addExportMatcher(
  packageName: string,
  subpath: string,
  matchers: SelfSpecifierMatchers,
): void {
  if (subpath.length === 0) {
    matchers.exact.add(packageName);
    return;
  }

  const wildcardIndex = subpath.indexOf('*');
  if (wildcardIndex !== -1) {
    matchers.prefixes.push(`${packageName}/${subpath.slice(0, wildcardIndex)}`);
    return;
  }

  matchers.exact.add(`${packageName}/${subpath}`);
}

function addExportKeyMatcher(
  packageName: string,
  exportKey: string,
  matchers: SelfSpecifierMatchers,
): void {
  const subpath = normalizeExportSubpath(exportKey);
  if (subpath !== null) {
    addExportMatcher(packageName, subpath, matchers);
  }
}

export function collectSelfSpecifierMatchers(
  packageName: string,
  exportsField: DistPackageJson['exports'],
): SelfSpecifierMatchers {
  const matchers: SelfSpecifierMatchers = {
    exact: new Set([packageName]),
    prefixes: [],
  };

  if (!isPlainRecord(exportsField)) {
    return matchers;
  }

  for (const exportKey of Object.keys(exportsField)) {
    addExportKeyMatcher(packageName, exportKey, matchers);
  }

  return matchers;
}

export function isAllowedSelfSpecifier(
  specifier: string,
  matchers: SelfSpecifierMatchers,
): boolean {
  return (
    matchers.exact.has(specifier) ||
    matchers.prefixes.some((prefix) => specifier.startsWith(prefix))
  );
}
