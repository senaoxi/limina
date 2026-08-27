import { normalizeAbsolutePath } from '#utils/path';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { svelte2tsx } from 'svelte2tsx';
import type ts from 'typescript';
import {
  isSupportedDependencyVersion,
  readResolvedPackageVersion,
} from '../../dependency-contract';
import { isResolvedFromLeafInstalledPackage } from '../packages/leaf-package-resolution';
import {
  createMissingCompilerError,
  createMissingTransformError,
  createMissingTypeScriptError,
  createUnsupportedTransformError,
  createUnsupportedTypeScriptError,
  svelte2tsxContract,
  typeScriptContract,
} from './toolchain-errors';

type SvelteTransform = typeof svelte2tsx;

interface Svelte2TsxModule {
  svelte2tsx?: unknown;
}

export interface SvelteCompiler {
  VERSION?: string;
  parse(source: string, options?: Record<string, unknown>): unknown;
}

export interface SvelteSemanticToolchain {
  compiler: SvelteCompiler;
  compilerPath: string;
  compilerVersion: string;
  transform: SvelteTransform;
  transformPath: string;
  transformVersion: string;
  tsModule: typeof ts;
  typeScriptPath: string;
  typeScriptVersion: string;
}

function hasErrorCode(error: unknown): error is { code: unknown } {
  return error !== null && typeof error === 'object' && 'code' in error;
}

function isModuleNotFoundError(error: unknown): boolean {
  return hasErrorCode(error) && error.code === 'MODULE_NOT_FOUND';
}

function resolvePackageSpecifier(options: {
  missingError: () => Error;
  requireFromLeaf: ReturnType<typeof createRequire>;
  specifier: string;
}): string {
  try {
    return normalizeAbsolutePath(
      options.requireFromLeaf.resolve(options.specifier),
    );
  } catch (error) {
    if (isModuleNotFoundError(error)) throw options.missingError();
    throw error;
  }
}

function requireLeafInstalledPackage(options: {
  missingError: () => Error;
  packageName: string;
  packageRootDir: string;
  resolvedPath: string;
}): string {
  if (
    !isResolvedFromLeafInstalledPackage({
      packageName: options.packageName,
      packageRootDir: options.packageRootDir,
      resolvedPath: options.resolvedPath,
    })
  ) {
    throw options.missingError();
  }
  return options.resolvedPath;
}

function resolveLeafPackageEntry(options: {
  missingError: () => Error;
  packageName: string;
  packageRootDir: string;
  requireFromLeaf: ReturnType<typeof createRequire>;
  specifier: string;
}): string {
  return requireLeafInstalledPackage({
    ...options,
    resolvedPath: resolvePackageSpecifier(options),
  });
}

function loadLeafCompiler(options: {
  packageRootDir: string;
  requireFromLeaf: ReturnType<typeof createRequire>;
}): { compiler: SvelteCompiler; compilerPath: string } {
  const compilerPath = resolveLeafPackageEntry({
    missingError: () => createMissingCompilerError(options.packageRootDir),
    packageName: 'svelte',
    packageRootDir: options.packageRootDir,
    requireFromLeaf: options.requireFromLeaf,
    specifier: 'svelte/compiler',
  });
  return {
    compiler: options.requireFromLeaf(compilerPath) as SvelteCompiler,
    compilerPath,
  };
}

function getCompilerVersion(options: {
  compiler: SvelteCompiler;
  compilerPath: string;
}): string {
  return (
    readResolvedPackageVersion({
      packageName: 'svelte',
      resolvedPath: options.compilerPath,
    }) ??
    options.compiler.VERSION ??
    'unknown'
  );
}

function requireTransform(
  requireFromLeaf: ReturnType<typeof createRequire>,
  transformPath: string,
): SvelteTransform {
  const module = requireFromLeaf(transformPath) as Svelte2TsxModule;
  if (typeof module.svelte2tsx === 'function') {
    return module.svelte2tsx as SvelteTransform;
  }
  throw new TypeError(
    `The installed svelte2tsx entry does not export a svelte2tsx function: ${transformPath}`,
  );
}

function loadLeafTransform(options: {
  packageRootDir: string;
  requireFromLeaf: ReturnType<typeof createRequire>;
}): {
  transform: SvelteTransform;
  transformPath: string;
  transformVersion: string;
} {
  const transformPath = resolveLeafPackageEntry({
    missingError: () => createMissingTransformError(options.packageRootDir),
    packageName: svelte2tsxContract.packageName,
    packageRootDir: options.packageRootDir,
    requireFromLeaf: options.requireFromLeaf,
    specifier: svelte2tsxContract.packageName,
  });
  const transformVersion = readResolvedPackageVersion({
    packageName: svelte2tsxContract.packageName,
    resolvedPath: transformPath,
  });
  if (
    transformVersion === undefined ||
    !isSupportedDependencyVersion({
      contract: svelte2tsxContract,
      version: transformVersion,
    })
  ) {
    throw createUnsupportedTransformError({
      packageRootDir: options.packageRootDir,
      version: transformVersion,
    });
  }
  return {
    transform: requireTransform(options.requireFromLeaf, transformPath),
    transformPath,
    transformVersion,
  };
}

function loadLeafTypeScript(options: {
  packageRootDir: string;
  requireFromLeaf: ReturnType<typeof createRequire>;
}): {
  tsModule: typeof ts;
  typeScriptPath: string;
  typeScriptVersion: string;
} {
  const typeScriptPath = resolveLeafPackageEntry({
    missingError: () => createMissingTypeScriptError(options.packageRootDir),
    packageName: 'typescript',
    packageRootDir: options.packageRootDir,
    requireFromLeaf: options.requireFromLeaf,
    specifier: 'typescript',
  });
  const typeScriptVersion = readResolvedPackageVersion({
    packageName: 'typescript',
    resolvedPath: typeScriptPath,
  });
  if (
    typeScriptVersion === undefined ||
    !isSupportedDependencyVersion({
      contract: typeScriptContract,
      version: typeScriptVersion,
    })
  ) {
    throw createUnsupportedTypeScriptError({
      packageRootDir: options.packageRootDir,
      version: typeScriptVersion,
    });
  }
  return {
    tsModule: options.requireFromLeaf(typeScriptPath) as typeof ts,
    typeScriptPath,
    typeScriptVersion,
  };
}

export function resolveSvelteSemanticToolchain(
  packageRootDir: string,
): SvelteSemanticToolchain {
  const requireFromLeaf = createRequire(
    path.join(packageRootDir, 'package.json'),
  );
  const { compiler, compilerPath } = loadLeafCompiler({
    packageRootDir,
    requireFromLeaf,
  });
  const transform = loadLeafTransform({ packageRootDir, requireFromLeaf });
  const typeScript = loadLeafTypeScript({ packageRootDir, requireFromLeaf });
  return {
    compiler,
    compilerPath,
    compilerVersion: getCompilerVersion({ compiler, compilerPath }),
    ...transform,
    ...typeScript,
  };
}
