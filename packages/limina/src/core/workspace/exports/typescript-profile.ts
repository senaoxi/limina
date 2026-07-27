import { normalizeExtensions } from '#checkers';
import { normalizeAbsolutePathIdentity } from '#utils/path';
import path from 'pathe';
import ts from 'typescript';
import { compareCodePoints } from '../typescript-resolution-semantics';
import type {
  TypeScriptProfileFallbackReason,
  TypeScriptResolutionSemanticsAdapter,
  TypeScriptWorkspaceExportProfileKey,
} from './profile-types';
import type { WorkspaceExportsResolutionProfile } from './types';

type CompilerOptionsWithPaths = ts.CompilerOptions & {
  noDtsResolution?: boolean;
  pathsBasePath?: string;
};

export type CompiledSemantics = Exclude<
  ReturnType<TypeScriptResolutionSemanticsAdapter['compile']>,
  { readonly fallbackReason: TypeScriptProfileFallbackReason }
>;

function getConfigDirectory(
  profile: WorkspaceExportsResolutionProfile,
): string | null {
  if (!path.isAbsolute(profile.configPath)) {
    return null;
  }

  return path.dirname(normalizeAbsolutePathIdentity(profile.configPath));
}

function resolveConfigRelativePath(
  value: string,
  configDirectory: string,
): string {
  return normalizeAbsolutePathIdentity(
    path.isAbsolute(value) ? value : path.resolve(configDirectory, value),
  );
}

function addStringOptionName(
  names: string[],
  name: string,
  value: unknown,
): void {
  if (typeof value === 'string') {
    names.push(name);
  }
}

function hasTypeRoots(options: CompilerOptionsWithPaths): boolean {
  return options.typeRoots !== undefined && options.typeRoots.length > 0;
}

function collectConfigRelativeOptionNames(
  options: CompilerOptionsWithPaths,
): string[] {
  const names: string[] = [];
  addStringOptionName(names, 'baseUrl', options.baseUrl);
  addStringOptionName(names, 'pathsBasePath', options.pathsBasePath);

  if (hasTypeRoots(options)) {
    names.push('typeRoots');
  }

  return names;
}

function getConfigRelativeFallback(options: {
  configDirectory: string | null;
  optionNames: readonly string[];
}): TypeScriptProfileFallbackReason | null {
  return options.configDirectory === null && options.optionNames.length > 0
    ? {
        kind: 'unresolved-config-relative-path',
        optionNames: options.optionNames,
      }
    : null;
}

function resolveOptionalConfigPath(
  value: unknown,
  configDirectory: string | null,
): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  return configDirectory === null
    ? null
    : resolveConfigRelativePath(value, configDirectory);
}

function createPathsEntries(
  compilerOptions: CompilerOptionsWithPaths,
): readonly (readonly [string, readonly string[]])[] {
  return Object.entries(compilerOptions.paths ?? {}).map(
    ([pattern, targets]) => [
      pattern,
      targets.map((target) =>
        path.isAbsolute(target)
          ? normalizeAbsolutePathIdentity(target)
          : target,
      ),
    ],
  );
}

function selectPathsBasePath(
  baseUrl: string | null,
  explicitPathsBasePath: string | null,
): string {
  if (baseUrl !== null) {
    return baseUrl;
  }

  return explicitPathsBasePath === null
    ? normalizeAbsolutePathIdentity(ts.sys.getCurrentDirectory())
    : explicitPathsBasePath;
}

function resolvePathsBasePath(options: {
  baseUrl: string | null;
  explicitPathsBasePath: string | null;
  pathsEntries: readonly unknown[];
}): string | null {
  return options.pathsEntries.length === 0
    ? options.explicitPathsBasePath
    : selectPathsBasePath(options.baseUrl, options.explicitPathsBasePath);
}

function usesModernResolution(kind: ts.ModuleResolutionKind): boolean {
  return [
    ts.ModuleResolutionKind.Node16,
    ts.ModuleResolutionKind.NodeNext,
    ts.ModuleResolutionKind.Bundler,
  ].includes(kind);
}

function resolveTypeRoots(options: {
  compilerOptions: CompilerOptionsWithPaths;
  configDirectory: string | null;
  moduleResolution: ts.ModuleResolutionKind;
}): string[] | null {
  if (usesModernResolution(options.moduleResolution)) {
    return null;
  }

  const typeRoots = options.compilerOptions.typeRoots;

  if (typeRoots === undefined) {
    return null;
  }

  return typeRoots.map((typeRoot) =>
    resolveConfigRelativePath(typeRoot, options.configDirectory!),
  );
}

function createNativeKey(options: {
  compiledSemantics: CompiledSemantics;
  configDirectory: string | null;
  profile: WorkspaceExportsResolutionProfile;
}): TypeScriptWorkspaceExportProfileKey {
  const compilerOptions = options.profile.options as CompilerOptionsWithPaths;
  const baseUrl = resolveOptionalConfigPath(
    compilerOptions.baseUrl,
    options.configDirectory,
  );
  const explicitPathsBasePath = resolveOptionalConfigPath(
    compilerOptions.pathsBasePath,
    options.configDirectory,
  );
  const pathsEntries = createPathsEntries(compilerOptions);
  const pathsBasePath = resolvePathsBasePath({
    baseUrl,
    explicitPathsBasePath,
    pathsEntries,
  });
  const customConditions = [...new Set(compilerOptions.customConditions)].sort(
    compareCodePoints,
  );

  return [
    'native-v1',
    options.compiledSemantics.effectiveAllowJs,
    options.compiledSemantics.effectiveModuleResolution,
    options.compiledSemantics.effectiveResolveJsonModule,
    options.compiledSemantics.effectiveResolvePackageJsonExports,
    baseUrl,
    pathsBasePath,
    pathsEntries,
    compilerOptions.moduleSuffixes ?? [],
    customConditions,
    compilerOptions.preserveSymlinks === true,
    compilerOptions.noDtsResolution === true,
    normalizeExtensions(options.profile.extensions),
    resolveTypeRoots({
      compilerOptions,
      configDirectory: options.configDirectory,
      moduleResolution: options.compiledSemantics.effectiveModuleResolution,
    }),
  ];
}

export function compileNativeTypeScriptKey(options: {
  compiledSemantics: CompiledSemantics;
  profile: WorkspaceExportsResolutionProfile;
}):
  | { readonly fallbackReason: TypeScriptProfileFallbackReason }
  | { readonly key: TypeScriptWorkspaceExportProfileKey } {
  const configDirectory = getConfigDirectory(options.profile);
  const compilerOptions = options.profile.options as CompilerOptionsWithPaths;
  const fallbackReason = getConfigRelativeFallback({
    configDirectory,
    optionNames: collectConfigRelativeOptionNames(compilerOptions),
  });

  return fallbackReason === null
    ? {
        key: createNativeKey({
          compiledSemantics: options.compiledSemantics,
          configDirectory,
          profile: options.profile,
        }),
      }
    : { fallbackReason };
}
