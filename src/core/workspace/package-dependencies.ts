import type {
  DependencySection,
  NamedWorkspacePackage,
  PackageManifest,
  WorkspacePackage,
} from './package-types';
import { isNamedWorkspacePackage } from './package-types';

const localDependencyPrefixes = [
  'workspace:',
  'link:',
  'file:',
  'catalog:',
] as const;

export function getDependencySections(
  importer: PackageManifest,
): Record<string, string>[] {
  return [
    importer.dependencies,
    importer.devDependencies,
    importer.optionalDependencies,
    importer.peerDependencies,
  ].filter(
    (section): section is Record<string, string> => section !== undefined,
  );
}

export function getPublishDependencySections(
  importer: PackageManifest,
): DependencySection[] {
  return [
    { dependencies: importer.dependencies, name: 'dependencies' },
    { dependencies: importer.peerDependencies, name: 'peerDependencies' },
    {
      dependencies: importer.optionalDependencies,
      name: 'optionalDependencies',
    },
  ].filter(
    (section): section is DependencySection =>
      section.dependencies !== undefined,
  );
}

export function isWorkspaceDependencySpecifier(specifier: string): boolean {
  return specifier.startsWith('workspace:');
}

export function isLocalPackageDependencySpecifier(specifier: string): boolean {
  return localDependencyPrefixes.some((prefix) => specifier.startsWith(prefix));
}

function getScopedPackageRoot(specifier: string): string {
  const parts = specifier.split('/');

  if (parts.length < 2) {
    return specifier;
  }

  return `${parts[0]}/${parts[1]}`;
}

export function getPackageRootSpecifier(specifier: string): string {
  if (specifier.startsWith('@')) {
    return getScopedPackageRoot(specifier);
  }

  return specifier.split('/')[0] ?? specifier;
}

export function findPackageForSpecifier(
  specifier: string,
  packages: WorkspacePackage[],
): NamedWorkspacePackage | null {
  const packageName = getPackageRootSpecifier(specifier);
  return (
    packages
      .filter(isNamedWorkspacePackage)
      .find((workspacePackage) => workspacePackage.name === packageName) ?? null
  );
}
