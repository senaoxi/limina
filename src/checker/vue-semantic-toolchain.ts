import { normalizeAbsolutePath } from '#utils/path';
import { isPlainRecord } from '#utils/values';
import { createRequire } from 'node:module';
import path from 'node:path';
import type ts from 'typescript';
import { LiminaDependencyError } from '../dependency-contract';
import {
  formatVueSemanticVersionTuple,
  resolveVueSemanticAdapter,
} from './vue-semantic-compatibility';
import type {
  VolarTypeScriptRuntime,
  VueLanguageRuntime,
  VueSemanticToolchain,
  VueSemanticToolchainPaths,
  VueSemanticVersionTuple,
} from './vue-semantic-types';

export {
  isSupportedVueSemanticVersionTuple,
  resolveVueSemanticAdapter,
} from './vue-semantic-compatibility';

const languageCoreFunctions = [
  'createLanguage',
  'createParsedCommandLine',
  'createVueLanguagePlugin',
  'getAllExtensions',
] as const;

function readManifestVersion(manifestPath: string): string {
  const manifest = createRequire(manifestPath)(manifestPath) as unknown;
  if (!isPlainRecord(manifest) || typeof manifest.version !== 'string') {
    throw new TypeError(
      `Package manifest ${manifestPath} does not expose a string version.`,
    );
  }
  return manifest.version;
}

function resolvePackageManifest(options: {
  checkerExecutionRootDir: string;
  packageName: string;
  requireFromVueTsc: NodeRequire;
  vueTscVersion: string;
}): string {
  try {
    return normalizeAbsolutePath(
      options.requireFromVueTsc.resolve(`${options.packageName}/package.json`),
    );
  } catch (error) {
    throw createUnsupportedVueToolchainError({
      checkerExecutionRootDir: options.checkerExecutionRootDir,
      reason: `the installed vue-tsc package could not resolve its internal dependency ${options.packageName}: ${formatToolchainError(error)}`,
      version: `vue-tsc ${options.vueTscVersion}`,
    });
  }
}

function formatToolchainError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createMissingVueTscError(options: {
  checkerExecutionRootDir: string;
  error: unknown;
}): LiminaDependencyError {
  return new LiminaDependencyError({
    failureKind: 'missing',
    message: [
      'Missing external checker:',
      '  checker: vue-tsc',
      `  checker execution scope: ${options.checkerExecutionRootDir}`,
      `  reason: ${formatToolchainError(options.error)}`,
      '  fix: install a supported vue-tsc version in this checker execution scope.',
    ].join('\n'),
    ownership: 'external-checker',
    packageName: 'vue-tsc',
    scope: options.checkerExecutionRootDir,
  });
}

export function createUnsupportedVueToolchainError(options: {
  checkerExecutionRootDir: string;
  reason: string;
  version?: string;
}): LiminaDependencyError {
  return new LiminaDependencyError({
    failureKind: 'unsupported',
    message: [
      'Unsupported vue-tsc toolchain:',
      '  checker: vue-tsc',
      `  checker execution scope: ${options.checkerExecutionRootDir}`,
      `  reason: ${options.reason}`,
      '  fix: upgrade, downgrade, or reinstall vue-tsc in this checker execution scope.',
    ].join('\n'),
    ownership: 'checker-toolchain',
    packageName: 'vue-tsc',
    scope: options.checkerExecutionRootDir,
    version: options.version,
  });
}

function resolveVueTscManifest(checkerExecutionRootDir: string): string {
  const requireFromExecutionScope = createRequire(
    path.join(checkerExecutionRootDir, 'package.json'),
  );
  try {
    return normalizeAbsolutePath(
      requireFromExecutionScope.resolve('vue-tsc/package.json'),
    );
  } catch (error) {
    throw createMissingVueTscError({ checkerExecutionRootDir, error });
  }
}

function resolveToolchainPaths(checkerExecutionRootDir: string): {
  paths: VueSemanticToolchainPaths;
  requireFromVueTsc: NodeRequire;
} {
  const vueTsc = resolveVueTscManifest(checkerExecutionRootDir);
  const requireFromVueTsc = createRequire(vueTsc);
  const vueTscVersion = readManifestVersion(vueTsc);
  return {
    paths: {
      languageCore: resolvePackageManifest({
        checkerExecutionRootDir,
        packageName: '@vue/language-core',
        requireFromVueTsc,
        vueTscVersion,
      }),
      typeScript: resolvePackageManifest({
        checkerExecutionRootDir,
        packageName: 'typescript',
        requireFromVueTsc,
        vueTscVersion,
      }),
      volarTypeScript: resolvePackageManifest({
        checkerExecutionRootDir,
        packageName: '@volar/typescript',
        requireFromVueTsc,
        vueTscVersion,
      }),
      vueTsc,
    },
    requireFromVueTsc,
  };
}

function readVersionTuple(
  paths: VueSemanticToolchainPaths,
): VueSemanticVersionTuple {
  return {
    languageCore: readManifestVersion(paths.languageCore),
    typeScript: readManifestVersion(paths.typeScript),
    volarTypeScript: readManifestVersion(paths.volarTypeScript),
    vueTsc: readManifestVersion(paths.vueTsc),
  };
}

export function createUnsupportedVueToolchainCompatibilityError(options: {
  checkerExecutionRootDir: string;
  tuple: VueSemanticVersionTuple;
}): LiminaDependencyError {
  const version = formatVueSemanticVersionTuple(options.tuple);
  return createUnsupportedVueToolchainError({
    checkerExecutionRootDir: options.checkerExecutionRootDir,
    reason: `the installed version tuple is outside Limina's supported semantic adapter matrix: ${version}`,
    version,
  });
}

function hasFunctionProperties(
  value: Record<string, unknown>,
  properties: readonly string[],
): boolean {
  return properties.every((property) => typeof value[property] === 'function');
}

function assertLanguageCoreRuntime(value: unknown): VueLanguageRuntime {
  if (
    !isPlainRecord(value) ||
    !hasFunctionProperties(value, languageCoreFunctions)
  ) {
    throw new TypeError(
      '@vue/language-core does not expose the approved semantic adapter API shape.',
    );
  }
  return value as unknown as VueLanguageRuntime;
}

function assertVolarTypeScriptRuntime(value: unknown): VolarTypeScriptRuntime {
  if (
    !isPlainRecord(value) ||
    !hasFunctionProperties(value, ['createLanguageServiceHost'])
  ) {
    throw new TypeError(
      '@volar/typescript does not expose createLanguageServiceHost.',
    );
  }
  return value as unknown as VolarTypeScriptRuntime;
}

function assertTypeScriptRuntime(value: unknown): typeof ts {
  if (
    !isPlainRecord(value) ||
    !hasFunctionProperties(value, [
      'createLanguageService',
      'parseJsonSourceFileConfigFileContent',
      'readJsonConfigFile',
    ])
  ) {
    throw new TypeError(
      'The Vue checker TypeScript package does not expose the approved compiler API shape.',
    );
  }
  return value as unknown as typeof ts;
}

function getToolchainVersionIdentity(
  versions: VueSemanticVersionTuple | undefined,
): string | undefined {
  if (versions !== undefined) return formatVueSemanticVersionTuple(versions);
  return undefined;
}

function rethrowToolchainResolutionError(options: {
  checkerExecutionRootDir: string;
  error: unknown;
  versions: VueSemanticVersionTuple | undefined;
}): never {
  if (options.error instanceof LiminaDependencyError) throw options.error;
  throw createUnsupportedVueToolchainError({
    checkerExecutionRootDir: options.checkerExecutionRootDir,
    reason: formatToolchainError(options.error),
    version: getToolchainVersionIdentity(options.versions),
  });
}

export function resolveVueSemanticToolchain(
  checkerExecutionRootDir: string,
): VueSemanticToolchain {
  let versions: VueSemanticVersionTuple | undefined;
  try {
    const resolved = resolveToolchainPaths(checkerExecutionRootDir);
    versions = readVersionTuple(resolved.paths);
    return {
      adapter: resolveVueSemanticAdapter(versions),
      languageCore: assertLanguageCoreRuntime(
        resolved.requireFromVueTsc('@vue/language-core'),
      ),
      paths: resolved.paths,
      tsModule: assertTypeScriptRuntime(
        resolved.requireFromVueTsc('typescript'),
      ),
      versions,
      volarTypeScript: assertVolarTypeScriptRuntime(
        resolved.requireFromVueTsc('@volar/typescript'),
      ),
    };
  } catch (error) {
    return rethrowToolchainResolutionError({
      checkerExecutionRootDir,
      error,
      versions,
    });
  }
}
