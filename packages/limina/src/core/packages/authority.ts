import type { PackageManifest } from '#core/workspace/actions';
import {
  isBarePackageSpecifier,
  isRelativeSpecifier,
} from '#utils/module-specifier';
import { isPlainRecord } from '#utils/values';

export {
  isBarePackageSpecifier,
  isPackageImportSpecifier,
  isUrlOrDataOrFileSpecifier,
  isVirtualModuleSpecifier,
} from '#utils/module-specifier';
export {
  collectWorkspaceDependencyDeclarations,
  createWorkspaceDependencyKey,
  isDependencyAuthorized,
  type WorkspaceDependencyDeclaration,
} from './dependency-authority';

export interface PackageImportMatch {
  key: string;
  targetKind: PackageImportTargetKind;
  value: unknown;
}

interface PackageImportPattern {
  key: string;
  wildcardIndex: number;
}

export type PackageImportTargetKind =
  | 'mixed'
  | 'package'
  | 'relative'
  | 'unknown';

function createPackageImportMatch(
  key: string,
  value: unknown,
): PackageImportMatch {
  return {
    key,
    targetKind: classifyPackageImportTarget(value),
    value,
  };
}

function findExactPackageImportMatch(
  importsField: Record<string, unknown>,
  specifier: string,
): PackageImportMatch | null {
  return Object.hasOwn(importsField, specifier)
    ? createPackageImportMatch(specifier, importsField[specifier])
    : null;
}

function isMatchesImportPattern(
  prefix: string,
  suffix: string,
  specifier: string,
): boolean {
  return specifier.startsWith(prefix) && specifier.endsWith(suffix);
}

function createMatchingPattern(
  key: string,
  specifier: string,
): PackageImportPattern | null {
  const wildcardIndex = key.indexOf('*');
  if (wildcardIndex === -1) {
    return null;
  }

  const prefix = key.slice(0, wildcardIndex);
  const suffix = key.slice(wildcardIndex + 1);
  return isMatchesImportPattern(prefix, suffix, specifier)
    ? { key, wildcardIndex }
    : null;
}

function comparePackageImportPatterns(
  left: PackageImportPattern,
  right: PackageImportPattern,
): number {
  const baseLengthDifference = right.wildcardIndex - left.wildcardIndex;
  return baseLengthDifference === 0
    ? right.key.length - left.key.length
    : baseLengthDifference;
}

function findWildcardPackageImportMatch(
  importsField: Record<string, unknown>,
  specifier: string,
): PackageImportMatch | null {
  const selectedPattern = Object.keys(importsField)
    .map((key) => createMatchingPattern(key, specifier))
    .filter((pattern): pattern is PackageImportPattern => pattern !== null)
    .sort(comparePackageImportPatterns)[0];

  return selectedPattern === undefined
    ? null
    : createPackageImportMatch(
        selectedPattern.key,
        importsField[selectedPattern.key],
      );
}

export function findPackageImportMatch(
  importsField: PackageManifest['imports'],
  specifier: string,
): PackageImportMatch | null {
  return isPlainRecord(importsField)
    ? (findExactPackageImportMatch(importsField, specifier) ??
        findWildcardPackageImportMatch(importsField, specifier))
    : null;
}

function getOnlyTargetKind(
  kinds: ReadonlySet<PackageImportTargetKind>,
): PackageImportTargetKind {
  const first = kinds.values().next();
  return first.done ? 'unknown' : first.value;
}

function resolveTargetKind(
  kinds: ReadonlySet<PackageImportTargetKind>,
): PackageImportTargetKind {
  if (kinds.size === 0) {
    return 'unknown';
  }

  return kinds.size === 1 ? getOnlyTargetKind(kinds) : 'mixed';
}

function classifyPackageImportTarget(value: unknown): PackageImportTargetKind {
  const kinds = new Set<PackageImportTargetKind>();
  collectPackageImportTargetKinds(value, kinds);
  return resolveTargetKind(kinds);
}

function classifyStringTarget(target: string): PackageImportTargetKind {
  if (isRelativeSpecifier(target)) {
    return 'relative';
  }

  return isBarePackageSpecifier(target) ? 'package' : 'unknown';
}

function getNestedTargetValues(value: unknown): unknown[] | null {
  if (Array.isArray(value)) {
    return value;
  }

  return isPlainRecord(value) ? Object.values(value) : null;
}

function collectNestedTargetKinds(
  values: readonly unknown[],
  kinds: Set<PackageImportTargetKind>,
): void {
  for (const value of values) {
    collectPackageImportTargetKinds(value, kinds);
  }
}

function addUnknownTargetKind(
  value: unknown,
  kinds: Set<PackageImportTargetKind>,
): void {
  if (value !== null && value !== undefined) {
    kinds.add('unknown');
  }
}

function collectPackageImportTargetKinds(
  value: unknown,
  kinds: Set<PackageImportTargetKind>,
): void {
  if (typeof value === 'string') {
    kinds.add(classifyStringTarget(value.trim()));
    return;
  }

  const nestedValues = getNestedTargetValues(value);
  if (nestedValues !== null) {
    collectNestedTargetKinds(nestedValues, kinds);
    return;
  }

  addUnknownTargetKind(value, kinds);
}
