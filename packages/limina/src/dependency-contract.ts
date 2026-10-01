import { readFileSync } from 'node:fs';
import path from 'node:path';
import semver from 'semver';

export type LiminaDependencyOwnership =
  | 'checker-toolchain'
  | 'external-checker'
  | 'limina-runtime';

export interface LiminaDependencyContract {
  optional: boolean;
  ownership: LiminaDependencyOwnership;
  packageName: string;
  supportedRange: string;
}

export type ExternalCheckerPackageName =
  | '@astrojs/check'
  | '@typescript/native-preview'
  | 'svelte-check'
  | 'vue-tsc';

export type CheckerToolchainPackageName = 'svelte2tsx';

export type LiminaRuntimePackageName =
  | '@arethetypeswrong/core'
  | 'knip'
  | 'npm-package-json-lint'
  | 'publint'
  | 'tsx'
  | 'typescript';

export const liminaRuntimeDependencyContracts: Readonly<
  Record<LiminaRuntimePackageName, LiminaDependencyContract>
> = {
  '@arethetypeswrong/core': {
    optional: true,
    ownership: 'limina-runtime',
    packageName: '@arethetypeswrong/core',
    supportedRange: '^0.18.3',
  },
  knip: {
    optional: true,
    ownership: 'limina-runtime',
    packageName: 'knip',
    supportedRange: '>=6.0.0 <7.0.0',
  },
  'npm-package-json-lint': {
    optional: true,
    ownership: 'limina-runtime',
    packageName: 'npm-package-json-lint',
    supportedRange: '>=9.1.0 <10.0.0',
  },
  publint: {
    optional: true,
    ownership: 'limina-runtime',
    packageName: 'publint',
    supportedRange: '>=0.3.0 <0.4.0',
  },
  tsx: {
    optional: true,
    ownership: 'limina-runtime',
    packageName: 'tsx',
    supportedRange: '^4.9.0',
  },
  typescript: {
    optional: false,
    ownership: 'limina-runtime',
    packageName: 'typescript',
    supportedRange: '>=5.4.0 <5.10.0 || >=6.0.0 <6.1.0',
  },
};

export const externalCheckerDependencyContracts: Readonly<
  Record<ExternalCheckerPackageName, LiminaDependencyContract>
> = {
  '@astrojs/check': {
    optional: true,
    ownership: 'external-checker',
    packageName: '@astrojs/check',
    supportedRange: '>=0.9.6 <0.10.0',
  },
  '@typescript/native-preview': {
    optional: true,
    ownership: 'external-checker',
    packageName: '@typescript/native-preview',
    supportedRange: '>=7.0.0-dev.20260421.2 <7.0.0',
  },
  'svelte-check': {
    optional: true,
    ownership: 'external-checker',
    packageName: 'svelte-check',
    supportedRange: '>=4.0.0 <5.0.0',
  },
  'vue-tsc': {
    optional: true,
    ownership: 'external-checker',
    packageName: 'vue-tsc',
    supportedRange: '>=2.2.0 <=2.2.12 || >=3.2.0 <=3.2.4',
  },
};

export const checkerToolchainDependencyContracts: Readonly<
  Record<CheckerToolchainPackageName, LiminaDependencyContract>
> = {
  svelte2tsx: {
    optional: true,
    ownership: 'checker-toolchain',
    packageName: 'svelte2tsx',
    supportedRange: '^0.7.61',
  },
};

export const vueCheckerToolchainPackages = [
  '@vue/language-core',
  '@volar/typescript',
  'typescript',
] as const;

interface PackageManifest {
  name?: unknown;
  version?: unknown;
}

function isExternalCheckerPackageName(
  packageName: string,
): packageName is ExternalCheckerPackageName {
  return Object.hasOwn(externalCheckerDependencyContracts, packageName);
}

function isCheckerToolchainPackageName(
  packageName: string,
): packageName is CheckerToolchainPackageName {
  return Object.hasOwn(checkerToolchainDependencyContracts, packageName);
}

function isLiminaRuntimePackageName(
  packageName: string,
): packageName is LiminaRuntimePackageName {
  return Object.hasOwn(liminaRuntimeDependencyContracts, packageName);
}

export function getExternalCheckerDependencyContract(
  packageName: string,
): LiminaDependencyContract | undefined {
  return isExternalCheckerPackageName(packageName)
    ? externalCheckerDependencyContracts[packageName]
    : undefined;
}

export function getCheckerToolchainDependencyContract(
  packageName: string,
): LiminaDependencyContract | undefined {
  return isCheckerToolchainPackageName(packageName)
    ? checkerToolchainDependencyContracts[packageName]
    : undefined;
}

export function getLiminaRuntimeDependencyContract(
  packageName: string,
): LiminaDependencyContract | undefined {
  return isLiminaRuntimePackageName(packageName)
    ? liminaRuntimeDependencyContracts[packageName]
    : undefined;
}

export function isSupportedDependencyVersion(options: {
  contract: LiminaDependencyContract;
  version: string;
}): boolean {
  return semver.satisfies(options.version, options.contract.supportedRange, {
    includePrerelease: true,
  });
}

function readPackageManifest(manifestPath: string): PackageManifest | null {
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest;
  } catch {
    return null;
  }
}

function isPackageManifest(
  manifest: PackageManifest | null,
  packageName: string,
): manifest is PackageManifest {
  return manifest !== null && manifest.name === packageName;
}

function* packageAncestorDirectories(
  startDirectory: string,
): Generator<string> {
  let directory = startDirectory;
  while (true) {
    yield directory;
    const parentDirectory = path.dirname(directory);
    if (parentDirectory === directory) return;
    directory = parentDirectory;
  }
}

function findPackageManifestInAncestors(options: {
  directory: string;
  packageName: string;
}): PackageManifest | null {
  const directories = packageAncestorDirectories(options.directory);
  for (const directory of directories) {
    const manifest = readPackageManifest(path.join(directory, 'package.json'));
    if (isPackageManifest(manifest, options.packageName)) return manifest;
  }
  return null;
}

function findResolvedPackageManifest(options: {
  packageName: string;
  resolvedPath: string;
}): PackageManifest | null {
  if (!path.isAbsolute(options.resolvedPath)) return null;
  return findPackageManifestInAncestors({
    directory: path.dirname(options.resolvedPath),
    packageName: options.packageName,
  });
}

export function readResolvedPackageVersion(options: {
  packageName: string;
  resolvedPath: string;
}): string | undefined {
  const manifest = findResolvedPackageManifest(options);
  return typeof manifest?.version === 'string' ? manifest.version : undefined;
}

export type LiminaDependencyFailureKind = 'missing' | 'unsupported';

export class LiminaDependencyError extends Error {
  readonly issueIdentity: string;
  readonly ownership: LiminaDependencyOwnership;
  readonly packageName: string;

  constructor(options: {
    failureKind: LiminaDependencyFailureKind;
    message: string;
    ownership: LiminaDependencyOwnership;
    packageName: string;
    scope: string;
    version?: string;
  }) {
    super(options.message);
    this.name = 'LiminaDependencyError';
    this.issueIdentity = JSON.stringify({
      failureKind: options.failureKind,
      ownership: options.ownership,
      packageName: options.packageName,
      scope: options.scope,
      version: options.version,
    });
    this.ownership = options.ownership;
    this.packageName = options.packageName;
  }
}

export function getLiminaDependencyIssueIdentity(
  error: unknown,
): string | undefined {
  return error instanceof LiminaDependencyError
    ? error.issueIdentity
    : undefined;
}
