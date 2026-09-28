import { uniqueCodeUnitSortedStrings as uniqueSortedStrings } from '#utils/collections';
import { isDeepStrictEqual } from 'node:util';
import type ts from 'typescript';

export const requiredDtsCompilerOptions: readonly (readonly [
  keyof ts.CompilerOptions,
  unknown,
])[] = [
  ['composite', true],
  ['incremental', true],
  ['noEmit', false],
  ['declaration', true],
];

export const requiredDtsPathOptions: readonly (keyof ts.CompilerOptions)[] = [
  'rootDir',
  'outDir',
  'tsBuildInfoFile',
];

export const comparableTypecheckOptions: readonly (keyof ts.CompilerOptions)[] =
  [
    'allowArbitraryExtensions',
    'allowImportingTsExtensions',
    'allowJs',
    'allowSyntheticDefaultImports',
    'baseUrl',
    'checkJs',
    'customConditions',
    'esModuleInterop',
    'exactOptionalPropertyTypes',
    'forceConsistentCasingInFileNames',
    'isolatedDeclarations',
    'isolatedModules',
    'jsx',
    'jsxImportSource',
    'lib',
    'module',
    'moduleDetection',
    'moduleResolution',
    'noFallthroughCasesInSwitch',
    'noImplicitAny',
    'noImplicitOverride',
    'noImplicitReturns',
    'noImplicitThis',
    'noPropertyAccessFromIndexSignature',
    'noUncheckedIndexedAccess',
    'paths',
    'resolveJsonModule',
    'skipLibCheck',
    'strict',
    'strictBindCallApply',
    'strictFunctionTypes',
    'strictNullChecks',
    'strictPropertyInitialization',
    'target',
    'useDefineForClassFields',
    'verbatimModuleSyntax',
  ];

export function formatCompilerOptionValue(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

function normalizeComparableCompilerOption(
  optionName: keyof ts.CompilerOptions,
  value: unknown,
): unknown {
  if (optionName !== 'customConditions') {
    return value;
  }

  return isStringArray(value) ? uniqueSortedStrings(value) : value;
}

export function compilerOptionEquals(
  optionName: keyof ts.CompilerOptions,
  left: unknown,
  right: unknown,
): boolean {
  return isDeepStrictEqual(
    normalizeComparableCompilerOption(optionName, left),
    normalizeComparableCompilerOption(optionName, right),
  );
}
