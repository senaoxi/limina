import {
  normalizeAbsolutePath,
  toPosixPath,
  toRelativePath,
} from '#utils/path';
import path from 'pathe';
import { createExternalArtifactStableId } from '../../domain/artifacts/namespace';
import type {
  GeneratedKnipPackageConfig,
  GeneratedKnipPackageDiagnostic,
  PreparedGeneratedKnipPackageConfig,
} from './generated-knip-types';

function isExternalPackageDirectory(relativeDirectory: string): boolean {
  return (
    relativeDirectory === '..' || relativeDirectory.startsWith(`..${path.sep}`)
  );
}

function getRelativeKnipConfigPath(relativeDirectory: string): string {
  if (relativeDirectory === '.') {
    return path.join('.limina/knip', 'tsconfig.knip.json');
  }

  if (isExternalPackageDirectory(relativeDirectory)) {
    return path.join(
      '.limina/knip/external',
      createExternalArtifactStableId(toPosixPath(relativeDirectory)),
      'tsconfig.knip.json',
    );
  }

  return path.join('.limina/knip', relativeDirectory, 'tsconfig.knip.json');
}

export function getGeneratedKnipConfigPath(options: {
  packageDirectory: string;
  rootDir: string;
}): string {
  const relativeDirectory = toRelativePath(
    options.rootDir,
    options.packageDirectory,
  );
  return normalizeAbsolutePath(
    path.join(options.rootDir, getRelativeKnipConfigPath(relativeDirectory)),
  );
}

export function createGeneratedKnipContent(options: {
  configPath: string;
  references: string[];
}): PreparedGeneratedKnipPackageConfig['content'] {
  return {
    files: [],
    references: options.references.map((referencePath) => ({
      path: toPosixPath(
        path.relative(path.dirname(options.configPath), referencePath),
      ),
    })),
  };
}

function toRootRelativePath(rootDir: string, targetPath: string): string {
  return toPosixPath(toRelativePath(rootDir, targetPath));
}

export function toManifestRelativePackageConfig(options: {
  config: GeneratedKnipPackageConfig;
  rootDir: string;
}): GeneratedKnipPackageConfig {
  return {
    ...options.config,
    configPath: toRootRelativePath(options.rootDir, options.config.configPath),
    packageDirectory: toRootRelativePath(
      options.rootDir,
      options.config.packageDirectory,
    ),
    packageJsonPath: toRootRelativePath(
      options.rootDir,
      options.config.packageJsonPath,
    ),
    references: options.config.references.map((reference) =>
      toRootRelativePath(options.rootDir, reference),
    ),
    scripts: options.config.scripts.map((script) => ({
      ...script,
      configPath: toRootRelativePath(options.rootDir, script.configPath),
    })),
  };
}

function resolveRootRelativePath(rootDir: string, value: string): string {
  return normalizeAbsolutePath(path.join(rootDir, value));
}

export function resolveGeneratedKnipPackageConfigs(options: {
  configs: GeneratedKnipPackageConfig[];
  rootDir: string;
}): GeneratedKnipPackageConfig[] {
  return options.configs.map((config) => ({
    ...config,
    configPath: resolveRootRelativePath(options.rootDir, config.configPath),
    packageDirectory: resolveRootRelativePath(
      options.rootDir,
      config.packageDirectory,
    ),
    packageJsonPath: resolveRootRelativePath(
      options.rootDir,
      config.packageJsonPath,
    ),
    references: config.references.map((reference) =>
      resolveRootRelativePath(options.rootDir, reference),
    ),
    scripts: config.scripts.map((script) => ({
      ...script,
      configPath: resolveRootRelativePath(options.rootDir, script.configPath),
    })),
  }));
}

export function resolveGeneratedKnipPackageDiagnostics(options: {
  diagnostics: GeneratedKnipPackageDiagnostic[];
  rootDir: string;
}): GeneratedKnipPackageDiagnostic[] {
  return options.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    packageJsonPath: resolveRootRelativePath(
      options.rootDir,
      diagnostic.packageJsonPath,
    ),
  }));
}

export function toManifestRelativeDiagnostic(
  diagnostic: GeneratedKnipPackageDiagnostic,
  rootDir: string,
): GeneratedKnipPackageDiagnostic {
  return {
    ...diagnostic,
    packageJsonPath: toRootRelativePath(rootDir, diagnostic.packageJsonPath),
  };
}
