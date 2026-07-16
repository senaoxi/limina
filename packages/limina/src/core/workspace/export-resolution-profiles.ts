import { getCheckerAdapter, normalizeExtensions } from '#checkers';
import {
  createOxcResolverProfileIdentity,
  type OxcResolverProfileIdentity,
} from '#core/import-analysis/runner';
import { normalizeAbsolutePathIdentity } from '#utils/path';
import path from 'pathe';
import ts from 'typescript';
import type { WorkspaceExportsResolutionProfile } from './exports';

export type TypeScriptProfileFallbackReason =
  | {
      readonly actualVersion: string;
      readonly kind: 'unsupported-runtime-version';
    }
  | {
      readonly helpers: readonly string[];
      readonly kind: 'missing-runtime-helper';
    }
  | {
      readonly kind: 'unclassified-compiler-option';
      readonly optionNames: readonly string[];
    }
  | {
      readonly kind: 'unresolved-config-relative-path';
      readonly optionNames: readonly string[];
    };

export type TypeScriptWorkspaceExportProfileKey =
  | readonly ['fallback-only-v1', extensions: readonly string[]]
  | readonly [
      'native-v1',
      effectiveAllowJs: boolean,
      effectiveModuleResolution: ts.ModuleResolutionKind,
      effectiveResolveJsonModule: boolean,
      effectiveResolvePackageJsonExports: boolean,
      baseUrl: string | null,
      pathsBasePath: string | null,
      paths: readonly (readonly [
        pattern: string,
        targets: readonly string[],
      ])[],
      moduleSuffixes: readonly string[],
      customConditions: readonly string[],
      preserveSymlinks: boolean,
      noDtsResolution: boolean,
      extensions: readonly string[],
      typeRoots: readonly string[] | null,
    ]
  | readonly [
      'singleton-fallback-v1',
      originalIndex: number,
      originalConfigPath: string,
    ];

export interface CompiledWorkspaceExportResolutionProfile {
  readonly original: WorkspaceExportsResolutionProfile;
  readonly originalConfigPath: string;
  readonly originalIndex: number;
  readonly oxcProfileId: string;
  readonly typescriptFallbackReason: TypeScriptProfileFallbackReason | null;
  readonly typescriptProfileId: string;
}

export interface TypeScriptResolverPlan {
  readonly id: string;
  readonly key: TypeScriptWorkspaceExportProfileKey;
  readonly memberIndexes: readonly number[];
  readonly representativeIndex: number;
}

export interface OxcResolverPlan
  extends Omit<OxcResolverProfileIdentity, 'id'> {
  readonly id: string;
  readonly memberIndexes: readonly number[];
  readonly representativeIndex: number;
}

export interface WorkspaceExportResolutionGroups {
  readonly byConfigPath: ReadonlyMap<
    string,
    CompiledWorkspaceExportResolutionProfile
  >;
  readonly compiledOriginals: readonly CompiledWorkspaceExportResolutionProfile[];
  readonly originals: readonly WorkspaceExportsResolutionProfile[];
  readonly oxcGroups: ReadonlyMap<string, OxcResolverPlan>;
  readonly typescriptGroups: ReadonlyMap<string, TypeScriptResolverPlan>;
}

export interface TypeScriptResolutionSemanticsAdapter {
  readonly auditedRuntimeVersion: '6.0.3';
  compile(options: ts.CompilerOptions):
    | {
        readonly effectiveAllowJs: boolean;
        readonly effectiveModuleResolution: ts.ModuleResolutionKind;
        readonly effectiveResolveJsonModule: boolean;
        readonly effectiveResolvePackageJsonExports: boolean;
      }
    | {
        readonly fallbackReason: TypeScriptProfileFallbackReason;
      };
}

export interface WorkspaceExportSelfNameContext {
  readonly containingFile: string;
  readonly eligible: boolean;
  readonly failureReason:
    | 'not-a-named-workspace-package'
    | 'missing-exports'
    | 'containing-file-mismatch'
    | 'specifier-is-not-self-name'
    | 'package-scope-unavailable'
    | null;
}

export interface WorkspaceExportSelfNameEntry {
  readonly hasExplicitExports: boolean;
  readonly isNamedWorkspacePackage: boolean;
  readonly packageDirectory: string;
  readonly packageJsonPath: string;
  readonly packageName: string;
  readonly specifier: string;
  readonly subpath: string;
}

interface TypeScriptRuntimeSemantics {
  readonly getAllowJSCompilerOption?: (options: ts.CompilerOptions) => boolean;
  readonly getEmitModuleResolutionKind?: (
    options: ts.CompilerOptions,
  ) => ts.ModuleResolutionKind;
  readonly getResolveJsonModule?: (options: ts.CompilerOptions) => boolean;
  readonly getResolvePackageJsonExports?: (
    options: ts.CompilerOptions,
  ) => boolean;
  readonly version?: string;
}

const auditedRuntimeVersion = '6.0.3' as const;
const runtimeHelperNames = [
  'getAllowJSCompilerOption',
  'getEmitModuleResolutionKind',
  'getResolveJsonModule',
  'getResolvePackageJsonExports',
] as const;

// Every enumerable CompilerOptions field accepted by the audited TS 6.0.3
// runtime is classified here. Fields used by workspace-export resolution are
// encoded below; the rest were audited as irrelevant to this narrow result.
const classifiedCompilerOptionNames = new Set([
  'allowArbitraryExtensions',
  'allowImportingTsExtensions',
  'allowJs',
  'allowSyntheticDefaultImports',
  'allowUmdGlobalAccess',
  'allowUnreachableCode',
  'allowUnusedLabels',
  'alwaysStrict',
  'assumeChangesOnlyAffectDirectDependencies',
  'baseUrl',
  'charset',
  'checkJs',
  'composite',
  'configFilePath',
  'customConditions',
  'declaration',
  'declarationDir',
  'declarationMap',
  'diagnostics',
  'disableReferencedProjectLoad',
  'disableSizeLimit',
  'disableSolutionSearching',
  'disableSourceOfProjectReferenceRedirect',
  'downlevelIteration',
  'emitBOM',
  'emitDeclarationOnly',
  'emitDecoratorMetadata',
  'erasableSyntaxOnly',
  'esModuleInterop',
  'exactOptionalPropertyTypes',
  'experimentalDecorators',
  'explainFiles',
  'extendedDiagnostics',
  'forceConsistentCasingInFileNames',
  'generateCpuProfile',
  'generateTrace',
  'ignoreDeprecations',
  'importHelpers',
  'importsNotUsedAsValues',
  'incremental',
  'inlineSourceMap',
  'inlineSources',
  'isolatedDeclarations',
  'isolatedModules',
  'jsx',
  'jsxFactory',
  'jsxFragmentFactory',
  'jsxImportSource',
  'keyofStringsOnly',
  'lib',
  'libReplacement',
  'listEmittedFiles',
  'listFiles',
  'listFilesOnly',
  'locale',
  'mapRoot',
  'maxNodeModuleJsDepth',
  'module',
  'moduleDetection',
  'moduleResolution',
  'moduleSuffixes',
  'newLine',
  'noCheck',
  'noDtsResolution',
  'noEmit',
  'noEmitHelpers',
  'noEmitOnError',
  'noErrorTruncation',
  'noFallthroughCasesInSwitch',
  'noImplicitAny',
  'noImplicitOverride',
  'noImplicitReturns',
  'noImplicitThis',
  'noImplicitUseStrict',
  'noLib',
  'noPropertyAccessFromIndexSignature',
  'noResolve',
  'noStrictGenericChecks',
  'noUncheckedIndexedAccess',
  'noUncheckedSideEffectImports',
  'noUnusedLocals',
  'noUnusedParameters',
  'out',
  'outDir',
  'outFile',
  'paths',
  'pathsBasePath',
  'plugins',
  'preserveConstEnums',
  'preserveSymlinks',
  'preserveValueImports',
  'preserveWatchOutput',
  'pretty',
  'reactNamespace',
  'removeComments',
  'resolveJsonModule',
  'resolvePackageJsonExports',
  'resolvePackageJsonImports',
  'rewriteRelativeImportExtensions',
  'rootDir',
  'rootDirs',
  'showConfig',
  'skipDefaultLibCheck',
  'skipLibCheck',
  'sourceMap',
  'sourceRoot',
  'stableTypeOrdering',
  'strict',
  'strictBindCallApply',
  'strictBuiltinIteratorReturn',
  'strictFunctionTypes',
  'strictNullChecks',
  'strictPropertyInitialization',
  'stripInternal',
  'suppressExcessPropertyErrors',
  'suppressImplicitAnyIndexErrors',
  'target',
  'traceResolution',
  'tsBuildInfoFile',
  'typeRoots',
  'types',
  'useDefineForClassFields',
  'useUnknownInCatchVariables',
  'verbatimModuleSyntax',
]);

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function createTypeScriptResolutionSemanticsAdapter(
  runtime: TypeScriptRuntimeSemantics = ts as TypeScriptRuntimeSemantics,
): TypeScriptResolutionSemanticsAdapter {
  const missingHelpers = runtimeHelperNames.filter(
    (name) => typeof runtime[name] !== 'function',
  );

  return {
    auditedRuntimeVersion,
    compile: (options) => {
      if (runtime.version !== auditedRuntimeVersion) {
        return {
          fallbackReason: {
            actualVersion: runtime.version ?? '<unknown>',
            kind: 'unsupported-runtime-version',
          },
        };
      }

      if (missingHelpers.length > 0) {
        return {
          fallbackReason: {
            helpers: missingHelpers,
            kind: 'missing-runtime-helper',
          },
        };
      }

      const optionNames = Object.keys(options)
        .filter((name) => !classifiedCompilerOptionNames.has(name))
        .sort(compareCodePoints);

      if (optionNames.length > 0) {
        return {
          fallbackReason: {
            kind: 'unclassified-compiler-option',
            optionNames,
          },
        };
      }

      return {
        effectiveAllowJs: runtime.getAllowJSCompilerOption!(options),
        effectiveModuleResolution:
          runtime.getEmitModuleResolutionKind!(options),
        effectiveResolveJsonModule: runtime.getResolveJsonModule!(options),
        effectiveResolvePackageJsonExports:
          runtime.getResolvePackageJsonExports!(options),
      };
    },
  };
}

function getEffectiveCheckerPresets(
  profile: WorkspaceExportsResolutionProfile,
): readonly string[] {
  return profile.checkerPresets.length > 0 ? profile.checkerPresets : ['tsc'];
}

function hasTypeScriptCheckerAdapter(
  profile: WorkspaceExportsResolutionProfile,
): boolean {
  return getEffectiveCheckerPresets(profile).some((preset) =>
    Boolean(getCheckerAdapter(preset)),
  );
}

function createSingletonTypeScriptKey(
  originalIndex: number,
  originalConfigPath: string,
): TypeScriptWorkspaceExportProfileKey {
  return ['singleton-fallback-v1', originalIndex, originalConfigPath];
}

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

function getConfigRelativePathFallbackReason(
  optionNames: readonly string[],
): TypeScriptProfileFallbackReason {
  return {
    kind: 'unresolved-config-relative-path',
    optionNames,
  };
}

function compileNativeTypeScriptKey(options: {
  compiledSemantics: Exclude<
    ReturnType<TypeScriptResolutionSemanticsAdapter['compile']>,
    { readonly fallbackReason: TypeScriptProfileFallbackReason }
  >;
  profile: WorkspaceExportsResolutionProfile;
}):
  | { readonly fallbackReason: TypeScriptProfileFallbackReason }
  | { readonly key: TypeScriptWorkspaceExportProfileKey } {
  const configDirectory = getConfigDirectory(options.profile);
  const compilerOptions = options.profile.options as ts.CompilerOptions & {
    noDtsResolution?: boolean;
    pathsBasePath?: string;
  };
  const configRelativeOptionNames = [
    ...(typeof compilerOptions.baseUrl === 'string' ? ['baseUrl'] : []),
    ...(typeof compilerOptions.pathsBasePath === 'string'
      ? ['pathsBasePath']
      : []),
    ...((compilerOptions.typeRoots?.length ?? 0) > 0 ? ['typeRoots'] : []),
  ];

  if (!configDirectory && configRelativeOptionNames.length > 0) {
    return {
      fallbackReason: getConfigRelativePathFallbackReason(
        configRelativeOptionNames,
      ),
    };
  }

  const baseUrl =
    typeof compilerOptions.baseUrl === 'string' && configDirectory
      ? resolveConfigRelativePath(compilerOptions.baseUrl, configDirectory)
      : null;
  const explicitPathsBasePath =
    typeof compilerOptions.pathsBasePath === 'string' && configDirectory
      ? resolveConfigRelativePath(
          compilerOptions.pathsBasePath,
          configDirectory,
        )
      : null;
  const pathsEntries = Object.entries(compilerOptions.paths ?? {}).map(
    ([pattern, targets]) =>
      [
        pattern,
        targets.map((target) =>
          path.isAbsolute(target)
            ? normalizeAbsolutePathIdentity(target)
            : target,
        ),
      ] as const,
  );
  const pathsBasePath =
    pathsEntries.length > 0
      ? (baseUrl ??
        explicitPathsBasePath ??
        normalizeAbsolutePathIdentity(ts.sys.getCurrentDirectory()))
      : explicitPathsBasePath;
  const customConditions = [...new Set(compilerOptions.customConditions)].sort(
    compareCodePoints,
  );
  const modernResolution = [
    ts.ModuleResolutionKind.Node16,
    ts.ModuleResolutionKind.NodeNext,
    ts.ModuleResolutionKind.Bundler,
  ].includes(options.compiledSemantics.effectiveModuleResolution);
  const typeRoots = modernResolution
    ? null
    : (compilerOptions.typeRoots?.map((typeRoot) =>
        resolveConfigRelativePath(typeRoot, configDirectory!),
      ) ?? null);

  return {
    key: [
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
      typeRoots,
    ],
  };
}

function compileTypeScriptProfile(options: {
  adapter: TypeScriptResolutionSemanticsAdapter;
  originalIndex: number;
  profile: WorkspaceExportsResolutionProfile;
}): {
  readonly fallbackReason: TypeScriptProfileFallbackReason | null;
  readonly id: string;
  readonly key: TypeScriptWorkspaceExportProfileKey;
} {
  if (!hasTypeScriptCheckerAdapter(options.profile)) {
    const key: TypeScriptWorkspaceExportProfileKey = [
      'fallback-only-v1',
      normalizeExtensions(options.profile.extensions),
    ];

    return {
      fallbackReason: null,
      id: JSON.stringify(key),
      key,
    };
  }

  const compiledSemantics = options.adapter.compile(options.profile.options);

  if ('fallbackReason' in compiledSemantics) {
    const key = createSingletonTypeScriptKey(
      options.originalIndex,
      options.profile.configPath,
    );

    return {
      fallbackReason: compiledSemantics.fallbackReason,
      id: JSON.stringify(key),
      key,
    };
  }

  const compiledKey = compileNativeTypeScriptKey({
    compiledSemantics,
    profile: options.profile,
  });

  if ('fallbackReason' in compiledKey) {
    const key = createSingletonTypeScriptKey(
      options.originalIndex,
      options.profile.configPath,
    );

    return {
      fallbackReason: compiledKey.fallbackReason,
      id: JSON.stringify(key),
      key,
    };
  }

  return {
    fallbackReason: null,
    id: JSON.stringify(compiledKey.key),
    key: compiledKey.key,
  };
}

function addTypeScriptPlanMember(
  groups: Map<string, TypeScriptResolverPlan>,
  id: string,
  key: TypeScriptWorkspaceExportProfileKey,
  originalIndex: number,
): void {
  const existing = groups.get(id);

  groups.set(
    id,
    existing
      ? {
          ...existing,
          memberIndexes: [...existing.memberIndexes, originalIndex],
        }
      : {
          id,
          key,
          memberIndexes: [originalIndex],
          representativeIndex: originalIndex,
        },
  );
}

function addOxcPlanMember(
  groups: Map<string, OxcResolverPlan>,
  identity: OxcResolverProfileIdentity,
  originalIndex: number,
): void {
  const existing = groups.get(identity.id);

  groups.set(
    identity.id,
    existing
      ? {
          ...existing,
          memberIndexes: [...existing.memberIndexes, originalIndex],
        }
      : {
          ...identity,
          memberIndexes: [originalIndex],
          representativeIndex: originalIndex,
        },
  );
}

export function compileWorkspaceExportResolutionGroups(
  originals: readonly WorkspaceExportsResolutionProfile[],
  options: {
    readonly typeScriptAdapter?: TypeScriptResolutionSemanticsAdapter;
  } = {},
): WorkspaceExportResolutionGroups {
  const adapter =
    options.typeScriptAdapter ?? createTypeScriptResolutionSemanticsAdapter();
  const byConfigPath = new Map<
    string,
    CompiledWorkspaceExportResolutionProfile
  >();
  const compiledOriginals: CompiledWorkspaceExportResolutionProfile[] = [];
  const oxcGroups = new Map<string, OxcResolverPlan>();
  const typescriptGroups = new Map<string, TypeScriptResolverPlan>();

  for (const [originalIndex, profile] of originals.entries()) {
    const compiledTypeScript = compileTypeScriptProfile({
      adapter,
      originalIndex,
      profile,
    });
    const oxcIdentity = createOxcResolverProfileIdentity({
      compilerOptions: profile.options,
      context: {
        checkerPresets: profile.checkerPresets,
        configPath: profile.configPath,
        extensions: profile.extensions,
        resolverConfigPath: profile.resolverConfigPath,
      },
    });
    const compiled: CompiledWorkspaceExportResolutionProfile = {
      original: profile,
      originalConfigPath: profile.configPath,
      originalIndex,
      oxcProfileId: oxcIdentity.id,
      typescriptFallbackReason: compiledTypeScript.fallbackReason,
      typescriptProfileId: compiledTypeScript.id,
    };

    compiledOriginals.push(compiled);
    byConfigPath.set(profile.configPath, compiled);
    addTypeScriptPlanMember(
      typescriptGroups,
      compiledTypeScript.id,
      compiledTypeScript.key,
      originalIndex,
    );
    addOxcPlanMember(oxcGroups, oxcIdentity, originalIndex);
  }

  return {
    byConfigPath,
    compiledOriginals,
    originals,
    oxcGroups,
    typescriptGroups,
  };
}

export function getWorkspaceExportSelfNameContext(options: {
  readonly entry: WorkspaceExportSelfNameEntry;
  readonly system?: Pick<ts.System, 'fileExists' | 'readFile'>;
}): WorkspaceExportSelfNameContext {
  const containingFile = normalizeAbsolutePathIdentity(
    path.join(options.entry.packageDirectory, 'package.json'),
  );
  const fail = (
    failureReason: NonNullable<WorkspaceExportSelfNameContext['failureReason']>,
  ): WorkspaceExportSelfNameContext => ({
    containingFile,
    eligible: false,
    failureReason,
  });

  if (!options.entry.isNamedWorkspacePackage) {
    return fail('not-a-named-workspace-package');
  }

  if (!options.entry.hasExplicitExports) {
    return fail('missing-exports');
  }

  if (
    containingFile !==
    normalizeAbsolutePathIdentity(options.entry.packageJsonPath)
  ) {
    return fail('containing-file-mismatch');
  }

  const expectedSpecifier =
    options.entry.subpath === '.'
      ? options.entry.packageName
      : `${options.entry.packageName}/${options.entry.subpath.slice('./'.length)}`;

  if (options.entry.specifier !== expectedSpecifier) {
    return fail('specifier-is-not-self-name');
  }

  const system = options.system ?? ts.sys;

  try {
    if (!system.fileExists(containingFile)) {
      return fail('package-scope-unavailable');
    }

    const source = system.readFile(containingFile);
    const manifest = source ? JSON.parse(source) : null;

    if (!isRecord(manifest) || manifest.name !== options.entry.packageName) {
      return fail('package-scope-unavailable');
    }

    if (!Object.hasOwn(manifest, 'exports')) {
      return fail('missing-exports');
    }
  } catch {
    return fail('package-scope-unavailable');
  }

  return {
    containingFile,
    eligible: true,
    failureReason: null,
  };
}
