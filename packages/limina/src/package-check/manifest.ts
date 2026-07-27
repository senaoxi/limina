import { isLocalPackageDependencySpecifier } from '#core/workspace/actions';
import { isPlainRecord } from '#utils/values';
import type { DistPackageJson } from './manifest-types';

export { findPackageImportTargets } from './manifest-imports';
export {
  collectSelfSpecifierMatchers,
  isAllowedSelfSpecifier,
} from './manifest-self-specifiers';
export type {
  DistPackageJson,
  PackageImportTargetMatch,
  SelfSpecifierMatchers,
} from './manifest-types';

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

const packageDependencySectionNames: readonly PackageDependencySectionName[] = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

function collectSectionDependencyEntries(
  manifest: DistPackageJson,
  sectionName: PackageDependencySectionName,
): PackageDependencyEntry[] {
  const section = manifest[sectionName];

  if (!isPlainRecord(section)) {
    return [];
  }

  return Object.entries(section)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([dependencyName, specifier]) => ({
      dependencyName,
      sectionName,
      specifier,
    }));
}

function collectPackageDependencyEntries(
  manifest: DistPackageJson,
): PackageDependencyEntry[] {
  return packageDependencySectionNames.flatMap((sectionName) =>
    collectSectionDependencyEntries(manifest, sectionName),
  );
}

function createMissingNameProblem(options: {
  label: string;
  packageJsonPath: string;
}): string {
  return [
    `[${options.label}] output package.json is not a complete npm package manifest`,
    `  package.json: ${options.packageJsonPath}`,
    '  field: name',
    '  reason: built package outputs must include a non-empty package name.',
  ].join('\n');
}

function hasValidPackageName(manifest: DistPackageJson): boolean {
  return typeof manifest.name === 'string' && manifest.name.trim().length > 0;
}

function createLocalDependencyProblem(
  options: { label: string; packageJsonPath: string },
  entry: PackageDependencyEntry,
): string {
  return [
    `[${options.label}] output package.json exposes a pnpm-local dependency specifier`,
    `  package.json: ${options.packageJsonPath}`,
    `  dependency: ${entry.dependencyName}`,
    `  section: ${entry.sectionName}`,
    `  specifier: ${entry.specifier}`,
    '  reason: built package manifests must be publish-ready npm package manifests without workspace:, link:, file:, or catalog: specifiers.',
  ].join('\n');
}

function collectLocalDependencyProblems(options: {
  label: string;
  manifest: DistPackageJson;
  packageJsonPath: string;
}): string[] {
  return collectPackageDependencyEntries(options.manifest)
    .filter((entry) => isLocalPackageDependencySpecifier(entry.specifier))
    .map((entry) => createLocalDependencyProblem(options, entry));
}

export function collectBuiltPackageManifestProblems(options: {
  label: string;
  manifest: DistPackageJson;
  packageJsonPath: string;
}): string[] {
  const problems = collectLocalDependencyProblems(options);

  if (!hasValidPackageName(options.manifest)) {
    problems.unshift(createMissingNameProblem(options));
  }

  return problems;
}
