import {
  isLocalPackageDependencySpecifier,
  isWorkspaceDependencySpecifier,
} from '#core/workspace/actions';
import semver from 'semver';
import {
  collectPackageDependencyEntries,
  collectPublishDependencyEntries,
  getPackedDependencySpecifier,
  isLinkDependencySpecifier,
} from '../consistency/dependencies';
import {
  addPackedManifestFinding,
  formatDependencyLocation,
} from '../consistency/findings';
import type {
  DirectWorkspaceDependency,
  PackageDependencyEntry,
  PublishDependencyEntry,
  PublishManifest,
  ReleaseConsistencyState,
} from '../consistency/types';

interface PackedManifestContext {
  manifest: PublishManifest;
  packedManifestPath: string;
  packageManifestPath: string;
  rootPackageName: string;
  state: ReleaseConsistencyState;
}

function addPackedPublishSpecifierFinding(options: {
  context: PackedManifestContext;
  entry: PublishDependencyEntry;
}): void {
  addPackedManifestFinding(options.context.state, {
    facts: {
      dependencyName: options.entry.dependencyName,
      importerName: options.context.rootPackageName,
      kind: 'packed-publish-local-specifier',
      packedManifestPath: options.context.packedManifestPath,
      sectionName: options.entry.sectionName,
      specifier: options.entry.specifier,
    },
    filePath: options.context.packageManifestPath,
    message: `${formatDependencyLocation({
      dependencyName: options.entry.dependencyName,
      importerName: options.context.rootPackageName,
      sectionName: options.entry.sectionName,
      specifier: options.entry.specifier,
    })}: packed package manifest must not expose workspace: or link: dependency specifiers`,
    packageManifestPath: options.context.packageManifestPath,
    packageName: options.context.rootPackageName,
    section: 'packed-manifest',
    sectionTitle:
      'Packed package manifest is inconsistent with workspace publish dependencies:',
  });
}

function validatePublishSpecifier(options: {
  context: PackedManifestContext;
  entry: PublishDependencyEntry;
}): void {
  const local =
    isWorkspaceDependencySpecifier(options.entry.specifier) ||
    isLinkDependencySpecifier(options.entry.specifier);
  if (local) addPackedPublishSpecifierFinding(options);
}

function isUnresolvedPackedSpecifier(specifier: string): boolean {
  if (isWorkspaceDependencySpecifier(specifier)) return true;
  return isLinkDependencySpecifier(specifier);
}

function isCoveredPublishSpecifier(entry: PackageDependencyEntry): boolean {
  if (entry.sectionName === 'devDependencies') return false;
  return isUnresolvedPackedSpecifier(entry.specifier);
}

function addPackedLocalSpecifierFinding(options: {
  context: PackedManifestContext;
  entry: PackageDependencyEntry;
}): void {
  addPackedManifestFinding(options.context.state, {
    facts: {
      dependencyName: options.entry.dependencyName,
      importerName: options.context.rootPackageName,
      kind: 'packed-local-specifier',
      packedManifestPath: options.context.packedManifestPath,
      sectionName: options.entry.sectionName,
      specifier: options.entry.specifier,
    },
    filePath: options.context.packageManifestPath,
    message: `${formatDependencyLocation({
      dependencyName: options.entry.dependencyName,
      importerName: options.context.rootPackageName,
      sectionName: options.entry.sectionName,
      specifier: options.entry.specifier,
    })}: packed package manifest must not expose workspace:, link:, file:, or catalog: dependency specifiers in any dependency section`,
    packageManifestPath: options.context.packageManifestPath,
    packageName: options.context.rootPackageName,
    section: 'packed-manifest',
    sectionTitle:
      'Packed package manifest is inconsistent with workspace publish dependencies:',
  });
}

function validateLocalSpecifier(options: {
  context: PackedManifestContext;
  entry: PackageDependencyEntry;
}): void {
  if (!isLocalPackageDependencySpecifier(options.entry.specifier)) return;
  if (isCoveredPublishSpecifier(options.entry)) return;
  addPackedLocalSpecifierFinding(options);
}

function addMissingDirectDependencyFinding(options: {
  context: PackedManifestContext;
  dependency: DirectWorkspaceDependency;
}): void {
  addPackedManifestFinding(options.context.state, {
    facts: {
      dependencyName: options.dependency.dependencyName,
      importerName: options.context.rootPackageName,
      kind: 'packed-dependency-missing',
      packedManifestPath: options.context.packedManifestPath,
      sectionName: options.dependency.sectionName,
    },
    filePath: options.context.packageManifestPath,
    message: `${formatDependencyLocation({
      dependencyName: options.dependency.dependencyName,
      importerName: options.context.rootPackageName,
      sectionName: options.dependency.sectionName,
    })}: packed package manifest must keep every source workspace publish dependency`,
    packageManifestPath: options.context.packageManifestPath,
    packageName: options.context.rootPackageName,
    section: 'packed-manifest',
    sectionTitle:
      'Packed package manifest is inconsistent with workspace publish dependencies:',
  });
}

function packedRangeAcceptsTarget(options: {
  packedSpecifier: string;
  targetVersion: string | undefined;
}): boolean {
  if (options.targetVersion === undefined) return false;
  return semver.satisfies(options.targetVersion, options.packedSpecifier, {
    includePrerelease: true,
  });
}

function addRangeMismatchFinding(options: {
  context: PackedManifestContext;
  dependency: DirectWorkspaceDependency;
  packedSpecifier: string;
}): void {
  const targetVersion = options.dependency.targetPackage.manifest.version;
  addPackedManifestFinding(options.context.state, {
    facts: {
      actualRange: options.packedSpecifier,
      dependencyName: options.dependency.dependencyName,
      expectedVersion: targetVersion,
      importerName: options.context.rootPackageName,
      kind: 'packed-dependency-range-mismatch',
      packedManifestPath: options.context.packedManifestPath,
      sectionName: options.dependency.sectionName,
    },
    filePath: options.context.packageManifestPath,
    message: `${formatDependencyLocation({
      dependencyName: options.dependency.dependencyName,
      importerName: options.context.rootPackageName,
      sectionName: options.dependency.sectionName,
      specifier: options.packedSpecifier,
    })}: packed dependency range must include ${options.dependency.targetPackage.name}@${targetVersion ?? '(missing version)'}`,
    packageManifestPath: options.context.packageManifestPath,
    packageName: options.context.rootPackageName,
    section: 'packed-manifest',
    sectionTitle:
      'Packed package manifest is inconsistent with workspace publish dependencies:',
  });
}

function validateResolvedDirectDependency(options: {
  context: PackedManifestContext;
  dependency: DirectWorkspaceDependency;
  packedSpecifier: string;
}): void {
  if (isUnresolvedPackedSpecifier(options.packedSpecifier)) return;
  const targetVersion = options.dependency.targetPackage.manifest.version;
  if (
    !packedRangeAcceptsTarget({
      packedSpecifier: options.packedSpecifier,
      targetVersion,
    })
  ) {
    addRangeMismatchFinding(options);
  }
}

function validateDirectDependency(options: {
  context: PackedManifestContext;
  dependency: DirectWorkspaceDependency;
}): void {
  const packedSpecifier = getPackedDependencySpecifier(
    options.context.manifest,
    options.dependency.dependencyName,
  );
  if (packedSpecifier === undefined) {
    addMissingDirectDependencyFinding(options);
    return;
  }
  validateResolvedDirectDependency({ ...options, packedSpecifier });
}

function validatePublishSpecifiers(context: PackedManifestContext): void {
  for (const entry of collectPublishDependencyEntries(context.manifest)) {
    validatePublishSpecifier({ context, entry });
  }
}

function validateLocalSpecifiers(context: PackedManifestContext): void {
  for (const entry of collectPackageDependencyEntries(context.manifest)) {
    validateLocalSpecifier({ context, entry });
  }
}

function validateDirectDependencies(context: PackedManifestContext): void {
  for (const dependency of context.state.directWorkspaceDependencies) {
    validateDirectDependency({ context, dependency });
  }
}

export function validatePackedManifest(options: {
  manifest: PublishManifest;
  packedManifestPath: string;
  packageManifestPath: string;
  rootPackageName: string;
  state: ReleaseConsistencyState;
}): void {
  const context: PackedManifestContext = options;
  validatePublishSpecifiers(context);
  validateLocalSpecifiers(context);
  validateDirectDependencies(context);
}
