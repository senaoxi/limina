import { normalizeExtensions } from '#checkers';
import { uniqueValues } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import type { NapiResolveOptions } from 'oxc-resolver';
import ts from 'typescript';
import type {
  ImportResolveContextFields,
  ImportResolveContextInput,
  OxcResolverProfileIdentity,
  ResolvedImportContext,
} from './types';

const moduleKindNode18 = 101 as ts.ModuleKind;
const moduleKindNode20 = 102 as ts.ModuleKind;
const defaultOxcRuntimeExtensions = ['.js', '.json', '.node'];
const extensionAlias: NonNullable<NapiResolveOptions['extensionAlias']> = {
  '.cjs': ['.cjs', '.cts', '.d.cts'],
  '.js': ['.js', '.ts', '.tsx', '.d.ts'],
  '.jsx': ['.jsx', '.tsx'],
  '.mjs': ['.mjs', '.mts', '.d.mts'],
};

function getNormalizedPath(value: string | undefined): string | undefined {
  return value === undefined ? undefined : normalizeAbsolutePath(value);
}

function normalizeFieldContext(
  context: ImportResolveContextFields,
): ResolvedImportContext {
  return {
    astroSemanticProject: context.astroSemanticProject,
    checkerPresets: context.checkerPresets,
    configPath: getNormalizedPath(context.configPath),
    extensions: context.extensions,
    resolverConfigPath: getNormalizedPath(context.resolverConfigPath),
    semanticFamily: context.semanticFamily,
    svelteSemanticProject: context.svelteSemanticProject,
    typeScriptSemanticContext: context.typeScriptSemanticContext,
    vueSemanticIdentity: context.vueSemanticIdentity,
  };
}

export function normalizeContextInput(
  contextOrExtensions: ImportResolveContextInput = [],
): ResolvedImportContext {
  if (Array.isArray(contextOrExtensions)) {
    return {
      checkerPresets: [],
      extensions: contextOrExtensions,
    };
  }
  return normalizeFieldContext(contextOrExtensions);
}

export function getResolverExtensions(options: {
  compilerOptions: ts.CompilerOptions;
  context: ResolvedImportContext;
}): string[] {
  return normalizeExtensions([
    ...options.context.extensions,
    ...defaultOxcRuntimeExtensions,
  ]);
}

const MODULE_RESOLUTION_BY_MODULE_KIND = new Map<
  ts.ModuleKind,
  ts.ModuleResolutionKind
>([
  [ts.ModuleKind.Node16, ts.ModuleResolutionKind.Node16],
  [moduleKindNode18, ts.ModuleResolutionKind.Node16],
  [moduleKindNode20, ts.ModuleResolutionKind.Node16],
  [ts.ModuleKind.NodeNext, ts.ModuleResolutionKind.NodeNext],
  [ts.ModuleKind.Preserve, ts.ModuleResolutionKind.Bundler],
]);

function getModuleBasedResolutionKind(
  moduleKind: ts.ModuleKind | undefined,
): ts.ModuleResolutionKind {
  return moduleKind === undefined
    ? ts.ModuleResolutionKind.Node10
    : (MODULE_RESOLUTION_BY_MODULE_KIND.get(moduleKind) ??
        ts.ModuleResolutionKind.Node10);
}

export function getEffectiveModuleResolutionKind(
  compilerOptions: ts.CompilerOptions,
): ts.ModuleResolutionKind {
  return compilerOptions.moduleResolution === undefined
    ? getModuleBasedResolutionKind(compilerOptions.module)
    : compilerOptions.moduleResolution;
}

export function isSupportsPackageJsonExportsAndImports(
  compilerOptions: ts.CompilerOptions,
): boolean {
  const kind = getEffectiveModuleResolutionKind(compilerOptions);
  return [
    ts.ModuleResolutionKind.Node16,
    ts.ModuleResolutionKind.NodeNext,
    ts.ModuleResolutionKind.Bundler,
  ].includes(kind);
}

function getCustomConditions(compilerOptions: ts.CompilerOptions): string[] {
  return compilerOptions.customConditions === undefined
    ? []
    : compilerOptions.customConditions;
}

export function getConditionNames(
  compilerOptions: ts.CompilerOptions,
): string[] {
  if (!isSupportsPackageJsonExportsAndImports(compilerOptions)) return [];
  return uniqueValues([
    ...getCustomConditions(compilerOptions),
    'import',
    'require',
    'node',
    'default',
  ]);
}

function hasNonEmptyOption(value: readonly unknown[] | undefined): boolean {
  return value !== undefined && value.length > 0;
}

function hasClassicResolution(compilerOptions: ts.CompilerOptions): boolean {
  return compilerOptions.moduleResolution === ts.ModuleResolutionKind.Classic;
}

function hasDisabledPackageJsonResolution(
  compilerOptions: ts.CompilerOptions,
): boolean {
  return (
    compilerOptions.resolvePackageJsonExports === false ||
    compilerOptions.resolvePackageJsonImports === false
  );
}

function hasArbitraryExtensions(compilerOptions: ts.CompilerOptions): boolean {
  return compilerOptions.allowArbitraryExtensions === true;
}

function hasRootDirectories(compilerOptions: ts.CompilerOptions): boolean {
  return hasNonEmptyOption(compilerOptions.rootDirs);
}

function hasModuleSuffixes(compilerOptions: ts.CompilerOptions): boolean {
  return hasNonEmptyOption(compilerOptions.moduleSuffixes);
}

export function hasTypeScriptOnlyResolutionOptions(
  compilerOptions: ts.CompilerOptions,
): boolean {
  return [
    hasClassicResolution(compilerOptions),
    hasArbitraryExtensions(compilerOptions),
    hasDisabledPackageJsonResolution(compilerOptions),
    hasRootDirectories(compilerOptions),
    hasModuleSuffixes(compilerOptions),
  ].some(Boolean);
}

function getPackageJsonFields(
  isEnabled: boolean,
): Pick<NapiResolveOptions, 'exportsFields' | 'importsFields'> {
  return isEnabled ? {} : { exportsFields: [], importsFields: [] };
}

export function createResolverOptions(options: {
  compilerOptions: ts.CompilerOptions;
  configPath: string;
  extensions: string[];
}): NapiResolveOptions {
  const isPackageJsonExportsAndImports = isSupportsPackageJsonExportsAndImports(
    options.compilerOptions,
  );
  return {
    conditionNames: getConditionNames(options.compilerOptions),
    extensionAlias,
    extensions: options.extensions,
    ...getPackageJsonFields(isPackageJsonExportsAndImports),
    nodePath: false,
    symlinks: options.compilerOptions.preserveSymlinks !== true,
    tsconfig: { configFile: options.configPath },
  };
}

export function createOxcResolverProfileIdentityFromResolvedOptions(options: {
  compilerOptions: ts.CompilerOptions;
  configPath: string;
  extensions: string[];
}): OxcResolverProfileIdentity {
  const conditionNames = getConditionNames(options.compilerOptions);
  const isPackageJsonExportsAndImports = isSupportsPackageJsonExportsAndImports(
    options.compilerOptions,
  );
  const isPreserveSymlinks = options.compilerOptions.preserveSymlinks === true;
  const identity = {
    conditionNames,
    configPath: options.configPath,
    extensions: options.extensions,
    packageJsonExportsAndImports: isPackageJsonExportsAndImports,
    preserveSymlinks: isPreserveSymlinks,
  };
  return {
    ...identity,
    id: JSON.stringify({
      conditions: conditionNames,
      configPath: options.configPath,
      extensions: options.extensions,
      packageJsonExportsAndImports: isPackageJsonExportsAndImports,
      preserveSymlinks: isPreserveSymlinks,
    }),
  };
}

function getResolverConfigPath(context: ResolvedImportContext): string | null {
  if (context.resolverConfigPath !== undefined) {
    return context.resolverConfigPath;
  }
  return context.configPath === undefined ? null : context.configPath;
}

export function createOxcResolverProfileIdentity(options: {
  compilerOptions: ts.CompilerOptions;
  context: ImportResolveContextFields;
}): OxcResolverProfileIdentity {
  const context = normalizeContextInput(options.context);
  const configPath = getResolverConfigPath(context);
  if (configPath === null) {
    throw new Error(
      'Unable to create Oxc resolver identity without a configPath.',
    );
  }
  return createOxcResolverProfileIdentityFromResolvedOptions({
    compilerOptions: options.compilerOptions,
    configPath,
    extensions: getResolverExtensions({
      compilerOptions: options.compilerOptions,
      context,
    }),
  });
}

export function getRequiredOxcConfigPath(options: {
  containingFile: string;
  context: ResolvedImportContext;
  specifier: string;
}): string {
  const configPath = getResolverConfigPath(options.context);
  if (configPath !== null) return configPath;
  throw new Error(
    [
      'Unable to resolve module with Oxc:',
      `  specifier: ${options.specifier}`,
      `  containing file: ${options.containingFile}`,
      '  reason: Oxc resolution requires the importer tsconfig configPath.',
    ].join('\n'),
  );
}
