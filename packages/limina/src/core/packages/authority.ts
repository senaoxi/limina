import type {
  NamedWorkspacePackage,
  PackageManifest,
  WorkspacePackage,
} from '#core/workspace/actions';
import { isNamedWorkspacePackage } from '#core/workspace/actions';
import {
  isBarePackageSpecifier,
  isRelativeSpecifier,
} from '#utils/module-specifier';
import { isPlainRecord } from '#utils/values';
import path from 'pathe';

export {
  isBarePackageSpecifier,
  isPackageImportSpecifier,
  isUrlOrDataOrFileSpecifier,
  isVirtualModuleSpecifier,
} from '#utils/module-specifier';

export interface PackageImportMatch {
  key: string;
  targetKind: PackageImportTargetKind;
  value: unknown;
}

type DependencySectionName =
  | 'dependencies'
  | 'devDependencies'
  | 'peerDependencies'
  | 'optionalDependencies';

interface DependencyDeclaration {
  sectionName: DependencySectionName;
  specifier: string;
}

export type PackageImportTargetKind =
  | 'mixed'
  | 'package'
  | 'relative'
  | 'unknown';

export interface WorkspaceDependencyDeclaration {
  dependencyName: string;
  importer: NamedWorkspacePackage;
  packageJsonPath: string;
  sectionName: DependencySectionName;
  specifier: string;
}

const dependencySectionNames: DependencySectionName[] = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

function collectDependencyDeclarations(
  manifest: PackageManifest,
  packageName: string,
): DependencyDeclaration[] {
  const declarations: DependencyDeclaration[] = [];

  for (const sectionName of dependencySectionNames) {
    const section = manifest[sectionName];

    if (!section || typeof section !== 'object') {
      continue;
    }

    const specifier = section[packageName];

    if (typeof specifier !== 'string') {
      continue;
    }

    declarations.push({
      sectionName,
      specifier,
    });
  }

  return declarations;
}

export function createWorkspaceDependencyKey(
  importerName: string,
  dependencyName: string,
): string {
  return `${importerName}\0${dependencyName}`;
}

function getWorkspacePackageJsonPath(
  workspacePackage: NamedWorkspacePackage,
): string {
  return path.join(workspacePackage.directory, 'package.json');
}

function getDependencySection(
  manifest: PackageManifest,
  sectionName: DependencySectionName,
): Record<string, string> | null {
  const section = manifest[sectionName];

  if (!isPlainRecord(section)) {
    return null;
  }

  return Object.fromEntries(
    Object.entries(section).filter((entry): entry is [string, string] => {
      return typeof entry[1] === 'string';
    }),
  );
}

export function collectWorkspaceDependencyDeclarations(
  workspacePackages: WorkspacePackage[],
): WorkspaceDependencyDeclaration[] {
  const namedWorkspacePackages = workspacePackages.filter(
    isNamedWorkspacePackage,
  );
  const workspacePackageNames = new Set(
    namedWorkspacePackages.map((workspacePackage) => workspacePackage.name),
  );
  const declarations: WorkspaceDependencyDeclaration[] = [];

  for (const importer of namedWorkspacePackages) {
    for (const sectionName of dependencySectionNames) {
      const section = getDependencySection(importer.manifest, sectionName);

      if (!section) {
        continue;
      }

      for (const [dependencyName, specifier] of Object.entries(section)) {
        if (
          dependencyName === importer.name ||
          !workspacePackageNames.has(dependencyName)
        ) {
          continue;
        }

        declarations.push({
          dependencyName,
          importer,
          packageJsonPath: getWorkspacePackageJsonPath(importer),
          sectionName,
          specifier,
        });
      }
    }
  }

  return declarations.sort((left, right) => {
    if (left.packageJsonPath !== right.packageJsonPath) {
      return left.packageJsonPath.localeCompare(right.packageJsonPath);
    }

    if (left.dependencyName !== right.dependencyName) {
      return left.dependencyName.localeCompare(right.dependencyName);
    }

    return left.sectionName.localeCompare(right.sectionName);
  });
}

export function isDependencyAuthorized(
  manifest: PackageManifest,
  packageName: string,
): boolean {
  return collectDependencyDeclarations(manifest, packageName).length > 0;
}

export function findPackageImportMatch(
  importsField: PackageManifest['imports'],
  specifier: string,
): PackageImportMatch | null {
  if (!importsField || typeof importsField !== 'object') {
    return null;
  }

  if (Object.hasOwn(importsField, specifier)) {
    const value = importsField[specifier];

    return {
      key: specifier,
      targetKind: classifyPackageImportTarget(value),
      value,
    };
  }

  const matchingPatterns: { key: string; wildcardIndex: number }[] = [];

  for (const key of Object.keys(importsField)) {
    const wildcardIndex = key.indexOf('*');

    if (wildcardIndex === -1) {
      continue;
    }

    const prefix = key.slice(0, wildcardIndex);
    const suffix = key.slice(wildcardIndex + 1);

    if (specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
      matchingPatterns.push({ key, wildcardIndex });
    }
  }

  matchingPatterns.sort((left, right) => {
    const baseLengthDifference = right.wildcardIndex - left.wildcardIndex;

    if (baseLengthDifference !== 0) {
      return baseLengthDifference;
    }

    return right.key.length - left.key.length;
  });

  const selectedPattern = matchingPatterns[0];

  if (!selectedPattern) {
    return null;
  }

  const value = importsField[selectedPattern.key];

  return {
    key: selectedPattern.key,
    targetKind: classifyPackageImportTarget(value),
    value,
  };
}

function classifyPackageImportTarget(value: unknown): PackageImportTargetKind {
  const kinds = new Set<PackageImportTargetKind>();

  collectPackageImportTargetKinds(value, kinds);

  if (kinds.size === 0) {
    return 'unknown';
  }

  if (kinds.size === 1) {
    return kinds.values().next().value ?? 'unknown';
  }

  return 'mixed';
}

function collectPackageImportTargetKinds(
  value: unknown,
  kinds: Set<PackageImportTargetKind>,
): void {
  if (typeof value === 'string') {
    const target = value.trim();

    if (isRelativeSpecifier(target)) {
      kinds.add('relative');
      return;
    }

    if (isBarePackageSpecifier(target)) {
      kinds.add('package');
      return;
    }

    kinds.add('unknown');
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectPackageImportTargetKinds(item, kinds);
    }
    return;
  }

  if (isPlainRecord(value)) {
    for (const item of Object.values(value)) {
      collectPackageImportTargetKinds(item, kinds);
    }
    return;
  }

  if (value !== null && value !== undefined) {
    kinds.add('unknown');
  }
}
