import type { ResolvedCheckerModuleName } from '#checkers';
import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import { observedResolutionHost } from '../typescript-semantic/observed-resolution-host';
import {
  getResolutionOrigin,
  resolveModuleWithOrigin,
} from '../typescript-semantic/resolution-origin';
import type { SvelteSemanticProject } from './types';

function getVirtualSource(
  fileName: string,
  host: ts.ModuleResolutionHost,
): string | undefined {
  if (!fileName.endsWith('.d.svelte.ts')) return undefined;
  if (host.fileExists(fileName)) return undefined;
  const source = fileName.replace(/\.d\.svelte\.ts$/, '.svelte');
  return getExistingSource(source, host);
}

export function createSvelteResolutionHost(
  tsModule: typeof ts,
): ts.ModuleResolutionHost {
  const host = {
    ...observedResolutionHost(tsModule, tsModule.sys.getCurrentDirectory()),
    getCurrentDirectory: tsModule.sys.getCurrentDirectory,
  };
  return {
    ...host,
    fileExists: (fileName) =>
      getVirtualSource(fileName, host) !== undefined ||
      host.fileExists(fileName),
    readFile: (fileName) =>
      host.readFile(getVirtualSource(fileName, host) ?? fileName),
  };
}

function getMode(options: {
  literal: ts.StringLiteralLike;
  project: SvelteSemanticProject;
  sourceFile: ts.SourceFile;
  tsModule: typeof ts;
}): ts.ResolutionMode {
  // Svelte's explicit component extension has no ESM/CJS declaration variant.
  return options.literal.text.endsWith('.svelte')
    ? undefined
    : options.tsModule.getModeForUsageLocation(
        options.sourceFile,
        options.literal,
        options.project.options,
      );
}

function createTarget(
  resolved: ts.ResolvedModuleFull | undefined,
  tsModule: typeof ts,
): ResolvedCheckerModuleName | null {
  return resolved === undefined
    ? null
    : createResolvedTarget(resolved, tsModule);
}

function createResolvedTarget(
  resolved: ts.ResolvedModuleFull,
  tsModule: typeof ts,
): ResolvedCheckerModuleName {
  const source = getVirtualSource(resolved.resolvedFileName, tsModule.sys);
  return {
    isExternalLibraryImport: resolved.isExternalLibraryImport === true,
    resolvedBy: source === undefined ? 'typescript' : 'checker-source',
    resolutionOrigin: getResolutionOrigin(resolved),
    resolvedFileName: normalizeAbsolutePath(
      source ?? resolved.resolvedFileName,
    ),
  };
}

export function resolveSvelteModuleOccurrence(options: {
  literal: ts.StringLiteralLike;
  project: SvelteSemanticProject;
  redirectedReference?: ts.ResolvedProjectReference;
  host: ts.ModuleResolutionHost;
  cache: ts.ModuleResolutionCache;
  sourceFile: ts.SourceFile;
  tsModule: typeof ts;
}): { resolutionMode: string; target: ResolvedCheckerModuleName | null } {
  const mode = getMode(options);
  const resolved = resolveModuleWithOrigin(
    options.tsModule,
    options.literal.text,
    options.sourceFile.fileName,
    options.project.options,
    options.host,
    options.cache,
    options.redirectedReference,
    mode,
  ).resolvedModule;
  return {
    resolutionMode: String(mode),
    target: createTarget(resolved, options.tsModule),
  };
}

function getExistingSource(
  source: string,
  host: ts.ModuleResolutionHost,
): string | undefined {
  if (host.fileExists(`${source}.d.ts`)) return undefined;
  return host.fileExists(source) ? source : undefined;
}
