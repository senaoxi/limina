import { isLocalPackageDependencySpecifier } from '#core/workspace/actions';
import { isPlainRecord } from '#utils/values';

export interface DistPackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  exports?: Record<string, unknown>;
  imports?: Record<string, unknown>;
  name: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  private?: boolean;
}

export interface PackageImportTargetMatch {
  key: string;
  targets: unknown[];
}

export interface SelfSpecifierMatchers {
  exact: Set<string>;
  prefixes: string[];
}

type PackageDependencySectionName =
  | 'dependencies'
  | 'devDependencies'
  | 'optionalDependencies'
  | 'peerDependencies';

interface PackageDependencyEntry {
  dependencyName: string;
  sectionName: PackageDependencySectionName;
  specifier: string;
}

function collectPackageDependencyEntries(
  manifest: DistPackageJson,
): PackageDependencyEntry[] {
  const sectionNames: PackageDependencySectionName[] = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ];
  const entries: PackageDependencyEntry[] = [];

  for (const sectionName of sectionNames) {
    const section = manifest[sectionName];

    if (!isPlainRecord(section)) {
      continue;
    }

    for (const [dependencyName, specifier] of Object.entries(section)) {
      if (typeof specifier !== 'string') {
        continue;
      }

      entries.push({
        dependencyName,
        sectionName,
        specifier,
      });
    }
  }

  return entries;
}

export function collectBuiltPackageManifestProblems(options: {
  label: string;
  manifest: DistPackageJson;
  packageJsonPath: string;
}): string[] {
  const problems: string[] = [];

  if (
    typeof options.manifest.name !== 'string' ||
    options.manifest.name.trim().length === 0
  ) {
    problems.push(
      [
        `[${options.label}] output package.json is not a complete npm package manifest`,
        `  package.json: ${options.packageJsonPath}`,
        '  field: name',
        '  reason: built package outputs must include a non-empty package name.',
      ].join('\n'),
    );
  }

  for (const entry of collectPackageDependencyEntries(options.manifest)) {
    if (!isLocalPackageDependencySpecifier(entry.specifier)) {
      continue;
    }

    problems.push(
      [
        `[${options.label}] output package.json exposes a pnpm-local dependency specifier`,
        `  package.json: ${options.packageJsonPath}`,
        `  dependency: ${entry.dependencyName}`,
        `  section: ${entry.sectionName}`,
        `  specifier: ${entry.specifier}`,
        '  reason: built package manifests must be publish-ready npm package manifests without workspace:, link:, file:, or catalog: specifiers.',
      ].join('\n'),
    );
  }

  return problems;
}

export function collectSelfSpecifierMatchers(
  packageName: string,
  exportsField: DistPackageJson['exports'],
): SelfSpecifierMatchers {
  const exact = new Set<string>([packageName]);
  const prefixes: string[] = [];

  if (!isPlainRecord(exportsField)) {
    return {
      exact,
      prefixes,
    };
  }

  for (const exportKey of Object.keys(exportsField)) {
    if (exportKey === '.') {
      exact.add(packageName);
      continue;
    }

    if (!exportKey.startsWith('./')) {
      continue;
    }

    const normalizedSubpath = exportKey.slice('./'.length);

    if (normalizedSubpath.length === 0) {
      continue;
    }

    const wildcardIndex = normalizedSubpath.indexOf('*');

    if (wildcardIndex !== -1) {
      prefixes.push(
        `${packageName}/${normalizedSubpath.slice(0, wildcardIndex)}`,
      );
      continue;
    }

    exact.add(`${packageName}/${normalizedSubpath}`);
  }

  return {
    exact,
    prefixes,
  };
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

function collectConditionalTargets(value: unknown, targets: unknown[]): void {
  if (Array.isArray(value)) {
    for (const target of value) {
      collectConditionalTargets(target, targets);
    }
    return;
  }

  if (isPlainRecord(value)) {
    for (const target of Object.values(value)) {
      collectConditionalTargets(target, targets);
    }
    return;
  }

  targets.push(value);
}

export function findPackageImportTargets(
  importsField: DistPackageJson['imports'],
  specifier: string,
): PackageImportTargetMatch | null {
  if (!isPlainRecord(importsField)) {
    return null;
  }

  let key: string | undefined;
  let wildcardValue: string | null = null;

  if (Object.hasOwn(importsField, specifier)) {
    key = specifier;
  } else {
    const matches = Object.keys(importsField)
      .filter((candidate) => candidate.split('*').length === 2)
      .map((candidate) => {
        const wildcardIndex = candidate.indexOf('*');
        const prefix = candidate.slice(0, wildcardIndex);
        const suffix = candidate.slice(wildcardIndex + 1);

        if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
          return null;
        }

        return {
          key: candidate,
          wildcardIndex,
          wildcardValue: specifier.slice(
            prefix.length,
            specifier.length - suffix.length,
          ),
        };
      })
      .filter((match): match is NonNullable<typeof match> => match !== null)
      .sort((left, right) => {
        const prefixDifference = right.wildcardIndex - left.wildcardIndex;

        return prefixDifference === 0
          ? right.key.length - left.key.length
          : prefixDifference;
      });
    const match = matches[0];

    if (match) {
      key = match.key;
      wildcardValue = match.wildcardValue;
    }
  }

  if (!key) {
    return null;
  }

  const targets: unknown[] = [];

  collectConditionalTargets(importsField[key], targets);

  return {
    key,
    targets: targets.map((target) =>
      typeof target === 'string' && wildcardValue !== null
        ? target.replaceAll('*', wildcardValue)
        : target,
    ),
  };
}
