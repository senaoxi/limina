import { isPlainRecord } from '#utils/values';
import type {
  DistributionPackageJson,
  SelfSpecifierMatchers,
} from './manifest-types';

function nonEmptySubpath(value: string): string | null {
  return value.length === 0 ? null : value;
}

function normalizeExportSubpath(exportKey: string): string | null {
  if (exportKey === '.') {
    return '';
  }

  return exportKey.startsWith('./')
    ? nonEmptySubpath(exportKey.slice('./'.length))
    : null;
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
    matchers.patterns.push({
      prefix: `${packageName}/${subpath.slice(0, wildcardIndex)}`,
      suffix: subpath.slice(wildcardIndex + 1),
    });
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

function hasSubpathExportKeys(exportKeys: readonly string[]): boolean {
  return exportKeys.some((key) => key.startsWith('.'));
}

function collectObjectExportMatchers(
  packageName: string,
  exportsField: Record<string, unknown>,
  matchers: SelfSpecifierMatchers,
): SelfSpecifierMatchers {
  const exportKeys = Object.keys(exportsField);
  if (!hasSubpathExportKeys(exportKeys)) {
    matchers.exact.add(packageName);
    return matchers;
  }
  for (const exportKey of exportKeys) {
    addExportKeyMatcher(packageName, exportKey, matchers);
  }
  return matchers;
}

function collectNonObjectExportMatchers(
  packageName: string,
  exportsField: unknown,
  matchers: SelfSpecifierMatchers,
): SelfSpecifierMatchers {
  if (exportsField !== null) matchers.exact.add(packageName);
  return matchers;
}

export function collectSelfSpecifierMatchers(
  packageName: string,
  exportsField: DistributionPackageJson['exports'],
): SelfSpecifierMatchers {
  const matchers: SelfSpecifierMatchers = {
    exact: new Set(),
    patterns: [],
  };

  if (exportsField === undefined) {
    matchers.exact.add(packageName);
    return matchers;
  }
  return isPlainRecord(exportsField)
    ? collectObjectExportMatchers(packageName, exportsField, matchers)
    : collectNonObjectExportMatchers(packageName, exportsField, matchers);
}

export function isAllowedSelfSpecifier(
  specifier: string,
  matchers: SelfSpecifierMatchers,
): boolean {
  return (
    matchers.exact.has(specifier) ||
    matchers.patterns.some(
      ({ prefix, suffix }) =>
        specifier.startsWith(prefix) &&
        specifier.endsWith(suffix) &&
        specifier.length >= prefix.length + suffix.length,
    )
  );
}
