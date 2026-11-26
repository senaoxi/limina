import { isPlainRecord } from '#utils/values';
import { expandPackageImportTargets } from '../core/packages/import-targets';
import type {
  DistributionPackageJson,
  PackageImportTargetMatch,
} from './manifest-types';

interface WildcardImportMatch {
  key: string;
  wildcardIndex: number;
}

function getSingleWildcardIndex(candidate: string): number | null {
  const wildcardIndex = candidate.indexOf('*');
  if (wildcardIndex === -1) {
    return null;
  }

  return candidate.includes('*', wildcardIndex + 1) ? null : wildcardIndex;
}

function isMatchesWildcardPattern(
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
  return wildcardIndex === null ||
    !isMatchesWildcardPattern(candidate, specifier, wildcardIndex)
    ? null
    : { key: candidate, wildcardIndex };
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
): { key: string } | null {
  return Object.hasOwn(importsField, specifier)
    ? { key: specifier }
    : findWildcardImportMatch(importsField, specifier);
}

export function findPackageImportTargets(
  importsField: DistributionPackageJson['imports'],
  specifier: string,
): PackageImportTargetMatch | null {
  if (!isPlainRecord(importsField)) {
    return null;
  }

  const match = findImportMatch(importsField, specifier);
  return match === null
    ? null
    : {
        key: match.key,
        targets: expandPackageImportTargets(
          importsField[match.key],
          match.key,
          specifier,
        ),
      };
}
