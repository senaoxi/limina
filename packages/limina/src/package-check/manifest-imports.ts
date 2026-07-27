import { isPlainRecord } from '#utils/values';
import type {
  DistPackageJson,
  PackageImportTargetMatch,
} from './manifest-types';

interface WildcardImportMatch {
  key: string;
  wildcardIndex: number;
  wildcardValue: string;
}

function getConditionalTargets(value: unknown): unknown[] | null {
  if (Array.isArray(value)) {
    return value;
  }

  if (isPlainRecord(value)) {
    return Object.values(value);
  }

  return null;
}

function collectConditionalTargets(value: unknown, targets: unknown[]): void {
  const nestedTargets = getConditionalTargets(value);

  if (nestedTargets === null) {
    targets.push(value);
    return;
  }

  for (const target of nestedTargets) {
    collectConditionalTargets(target, targets);
  }
}

function getSingleWildcardIndex(candidate: string): number | null {
  const wildcardIndex = candidate.indexOf('*');
  if (wildcardIndex === -1) {
    return null;
  }

  return candidate.includes('*', wildcardIndex + 1) ? null : wildcardIndex;
}

function matchesWildcardPattern(
  candidate: string,
  specifier: string,
  wildcardIndex: number,
): boolean {
  const prefix = candidate.slice(0, wildcardIndex);
  const suffix = candidate.slice(wildcardIndex + 1);
  return specifier.startsWith(prefix) && specifier.endsWith(suffix);
}

function createWildcardImportMatch(
  candidate: string,
  specifier: string,
): WildcardImportMatch | null {
  const wildcardIndex = getSingleWildcardIndex(candidate);
  if (wildcardIndex === null) {
    return null;
  }

  if (!matchesWildcardPattern(candidate, specifier, wildcardIndex)) {
    return null;
  }

  const prefixLength = wildcardIndex;
  const suffixLength = candidate.length - wildcardIndex - 1;
  return {
    key: candidate,
    wildcardIndex,
    wildcardValue: specifier.slice(
      prefixLength,
      specifier.length - suffixLength,
    ),
  };
}

function compareWildcardMatches(
  left: WildcardImportMatch,
  right: WildcardImportMatch,
): number {
  const prefixDifference = right.wildcardIndex - left.wildcardIndex;
  return prefixDifference === 0
    ? right.key.length - left.key.length
    : prefixDifference;
}

function findWildcardImportMatch(
  importsField: Record<string, unknown>,
  specifier: string,
): WildcardImportMatch | null {
  return (
    Object.keys(importsField)
      .map((candidate) => createWildcardImportMatch(candidate, specifier))
      .filter((match): match is WildcardImportMatch => match !== null)
      .sort(compareWildcardMatches)[0] ?? null
  );
}

function findImportMatch(
  importsField: Record<string, unknown>,
  specifier: string,
): { key: string; wildcardValue: string | null } | null {
  if (Object.hasOwn(importsField, specifier)) {
    return { key: specifier, wildcardValue: null };
  }

  return findWildcardImportMatch(importsField, specifier);
}

function replaceWildcardTarget(
  target: unknown,
  wildcardValue: string | null,
): unknown {
  return typeof target === 'string' && wildcardValue !== null
    ? target.replaceAll('*', wildcardValue)
    : target;
}

export function findPackageImportTargets(
  importsField: DistPackageJson['imports'],
  specifier: string,
): PackageImportTargetMatch | null {
  if (!isPlainRecord(importsField)) {
    return null;
  }

  const match = findImportMatch(importsField, specifier);
  if (match === null) {
    return null;
  }

  const targets: unknown[] = [];
  collectConditionalTargets(importsField[match.key], targets);

  return {
    key: match.key,
    targets: targets.map((target) =>
      replaceWildcardTarget(target, match.wildcardValue),
    ),
  };
}
