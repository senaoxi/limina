import ts from 'typescript';
import type {
  TypeScriptProfileFallbackReason,
  TypeScriptResolutionSemanticsAdapter,
} from './exports/profile-types';

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

export function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function getRuntimeVersion(runtime: TypeScriptRuntimeSemantics): string {
  return runtime.version === undefined ? '<unknown>' : runtime.version;
}

function getRuntimeFallbackReason(
  runtime: TypeScriptRuntimeSemantics,
  missingHelpers: readonly string[],
): TypeScriptProfileFallbackReason | null {
  if (runtime.version !== auditedRuntimeVersion) {
    return {
      actualVersion: getRuntimeVersion(runtime),
      kind: 'unsupported-runtime-version',
    };
  }

  if (missingHelpers.length > 0) {
    return { helpers: missingHelpers, kind: 'missing-runtime-helper' };
  }

  return null;
}

function getOptionFallbackReason(
  options: ts.CompilerOptions,
): TypeScriptProfileFallbackReason | null {
  const optionNames = Object.keys(options)
    .filter((name) => !classifiedCompilerOptionNames.has(name))
    .sort(compareCodePoints);
  return optionNames.length === 0
    ? null
    : { kind: 'unclassified-compiler-option', optionNames };
}

function compileSemantics(
  options: ts.CompilerOptions,
  runtime: TypeScriptRuntimeSemantics,
  missingHelpers: readonly string[],
): ReturnType<TypeScriptResolutionSemanticsAdapter['compile']> {
  const runtimeFallback = getRuntimeFallbackReason(runtime, missingHelpers);

  if (runtimeFallback !== null) {
    return { fallbackReason: runtimeFallback };
  }

  const optionFallback = getOptionFallbackReason(options);

  if (optionFallback !== null) {
    return { fallbackReason: optionFallback };
  }

  return {
    effectiveAllowJs: runtime.getAllowJSCompilerOption!(options),
    effectiveModuleResolution: runtime.getEmitModuleResolutionKind!(options),
    effectiveResolveJsonModule: runtime.getResolveJsonModule!(options),
    effectiveResolvePackageJsonExports:
      runtime.getResolvePackageJsonExports!(options),
  };
}

export function createTypeScriptResolutionSemanticsAdapter(
  runtime: TypeScriptRuntimeSemantics = ts as TypeScriptRuntimeSemantics,
): TypeScriptResolutionSemanticsAdapter {
  const missingHelpers = runtimeHelperNames.filter(
    (name) => typeof runtime[name] !== 'function',
  );
  return {
    auditedRuntimeVersion,
    compile: (options) => compileSemantics(options, runtime, missingHelpers),
  };
}
