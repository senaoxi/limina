import type { PackageAttwIgnoreRule, PackageAttwProfile } from '#config/runner';
import type { Problem } from '@arethetypeswrong/core';

export const ATTW_PROFILE_IGNORED_RESOLUTIONS: Record<
  PackageAttwProfile,
  string[]
> = {
  strict: [],
  node16: ['node10'],
  'esm-only': ['node10', 'node16-cjs'],
};

const ATTW_PROBLEM_RULE_NAMES = {
  CJSOnlyExportsDefault: 'cjs-only-exports-default',
  CJSResolvesToESM: 'cjs-resolves-to-esm',
  FallbackCondition: 'fallback-condition',
  FalseCJS: 'false-cjs',
  FalseESM: 'false-esm',
  FalseExportDefault: 'false-export-default',
  InternalResolutionError: 'internal-resolution-error',
  MissingExportEquals: 'missing-export-equals',
  NamedExports: 'named-exports',
  NoResolution: 'no-resolution',
  UnexpectedModuleSyntax: 'unexpected-module-syntax',
  UntypedResolution: 'untyped-resolution',
} as const satisfies Record<string, PackageAttwIgnoreRule>;

function getResolutionSuffix(problem: Problem): string {
  if (!('resolutionKind' in problem)) return '';
  return ` [resolution: ${problem.resolutionKind}]`;
}

function getEntrypointSuffix(problem: Problem): string {
  if (!('entrypoint' in problem)) return '';
  return ` [entrypoint: ${problem.entrypoint}]`;
}

function getResolutionContext(problem: Problem): string {
  return `${getResolutionSuffix(problem)}${getEntrypointSuffix(problem)}`;
}

function formatNoResolution(problem: Problem): string {
  return `No resolution${getResolutionContext(problem)}`;
}

function formatUntypedResolution(problem: Problem): string {
  return `Untyped resolution${getResolutionContext(problem)}`;
}

function formatFalseEsm(
  problem: Extract<Problem, { kind: 'FalseESM' }>,
): string {
  return `False ESM: ${problem.typesFileName} -> ${problem.implementationFileName}`;
}

function formatFalseCjs(
  problem: Extract<Problem, { kind: 'FalseCJS' }>,
): string {
  return `False CJS: ${problem.typesFileName} -> ${problem.implementationFileName}`;
}

function formatCjsResolvesToEsm(problem: Problem): string {
  return `CJS resolves to ESM${getResolutionContext(problem)}`;
}

function formatFallbackCondition(problem: Problem): string {
  return `Fallback condition used${getResolutionContext(problem)}`;
}

function formatNamedExports(
  problem: Extract<Problem, { kind: 'NamedExports' }>,
): string {
  const missing = problem.isMissingAllNamed
    ? 'all named exports'
    : problem.missing.join(', ') || '(none)';
  return `Named exports missing: ${missing} [types: ${problem.typesFileName}] [implementation: ${problem.implementationFileName}]`;
}

function formatFalseExportDefault(
  problem: Extract<Problem, { kind: 'FalseExportDefault' }>,
): string {
  return `False export default [types: ${problem.typesFileName}] [implementation: ${problem.implementationFileName}]`;
}

function formatMissingExportEquals(
  problem: Extract<Problem, { kind: 'MissingExportEquals' }>,
): string {
  return `Missing export equals [types: ${problem.typesFileName}] [implementation: ${problem.implementationFileName}]`;
}

function formatInternalResolutionError(
  problem: Extract<Problem, { kind: 'InternalResolutionError' }>,
): string {
  return `Internal resolution error in ${problem.fileName} [option: ${problem.resolutionOption}] [module: ${problem.moduleSpecifier}]`;
}

function formatUnexpectedModuleSyntax(
  problem: Extract<Problem, { kind: 'UnexpectedModuleSyntax' }>,
): string {
  return `Unexpected module syntax in ${problem.fileName}`;
}

function formatCjsOnlyExportsDefault(
  problem: Extract<Problem, { kind: 'CJSOnlyExportsDefault' }>,
): string {
  return `CJS only exports default in ${problem.fileName}`;
}

type ProblemFormatter = (problem: never) => string;

const problemFormatters: Partial<Record<Problem['kind'], ProblemFormatter>> = {
  CJSOnlyExportsDefault: formatCjsOnlyExportsDefault as ProblemFormatter,
  CJSResolvesToESM: formatCjsResolvesToEsm as ProblemFormatter,
  FallbackCondition: formatFallbackCondition as ProblemFormatter,
  FalseCJS: formatFalseCjs as ProblemFormatter,
  FalseESM: formatFalseEsm as ProblemFormatter,
  FalseExportDefault: formatFalseExportDefault as ProblemFormatter,
  InternalResolutionError: formatInternalResolutionError as ProblemFormatter,
  MissingExportEquals: formatMissingExportEquals as ProblemFormatter,
  NamedExports: formatNamedExports as ProblemFormatter,
  NoResolution: formatNoResolution as ProblemFormatter,
  UnexpectedModuleSyntax: formatUnexpectedModuleSyntax as ProblemFormatter,
  UntypedResolution: formatUntypedResolution as ProblemFormatter,
};

export function formatAttwProblem(problem: Problem): string {
  const formatter = problemFormatters[problem.kind];
  if (formatter === undefined) {
    return `Unknown ATTW problem: ${JSON.stringify(problem)}`;
  }
  return formatter(problem as never);
}

export function getAttwProblemRuleName(
  problem: Problem,
): PackageAttwIgnoreRule {
  if (Object.hasOwn(ATTW_PROBLEM_RULE_NAMES, problem.kind)) {
    return ATTW_PROBLEM_RULE_NAMES[
      problem.kind as keyof typeof ATTW_PROBLEM_RULE_NAMES
    ];
  }
  return problem.kind;
}
