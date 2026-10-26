import type {
  PackageAttwCheckConfig,
  PackageAttwIgnoreRule,
  PackageAttwProfile,
} from '#config/runner';
import type { CheckPackageOptions, Problem } from '@arethetypeswrong/core';
import { createElapsedTimer } from 'logaria/helper';
import type { LiminaCheckIssue } from '../check-reporting/snapshot';
import {
  formatMissingOptionalToolSkipMessage,
  isLiminaOptionalToolMissingError,
} from '../execution/tools';
import type { LiminaFlowReporter } from '../flow';
import { PackageLogger } from '../logger';
import { addPackageCheckIssue } from './issue';
import { loadAttwPeer } from './peer-tools';
import type { PackageToolCheckResult } from './runner-types';

const ATTW_PROFILE_IGNORED_RESOLUTIONS: Record<PackageAttwProfile, string[]> = {
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
  return 'resolutionKind' in problem
    ? ` [resolution: ${problem.resolutionKind}]`
    : '';
}

function getEntrypointSuffix(problem: Problem): string {
  return 'entrypoint' in problem ? ` [entrypoint: ${problem.entrypoint}]` : '';
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

function formatAttwProblem(problem: Problem): string {
  const formatter = problemFormatters[problem.kind];
  return formatter === undefined
    ? `Unknown ATTW problem: ${JSON.stringify(problem)}`
    : formatter(problem as never);
}

function getAttwProblemRuleName(problem: Problem): PackageAttwIgnoreRule {
  return Object.hasOwn(ATTW_PROBLEM_RULE_NAMES, problem.kind)
    ? ATTW_PROBLEM_RULE_NAMES[
        problem.kind as keyof typeof ATTW_PROBLEM_RULE_NAMES
      ]
    : problem.kind;
}

interface AttwCheckOptions {
  config: PackageAttwCheckConfig;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  issueSink?: LiminaCheckIssue[];
  label: string;
  packageManifestPath: string;
  packageName?: string;
  profile: PackageAttwProfile;
  rootDir: string;
  tarball: Buffer;
}

type AttwTask = ReturnType<NonNullable<LiminaFlowReporter['start']>>;

function failTask(task: AttwTask | undefined, message: string): void {
  if (task !== undefined) task.fail(message);
}

function passTask(task: AttwTask | undefined): void {
  if (task !== undefined) task.pass();
}

function addNoTypesIssue(options: AttwCheckOptions): void {
  addPackageCheckIssue({
    code: 'LIMINA_PACKAGE_ATTW',
    detailLines: [`[${options.label}] [attw] package has no types`],
    evidence: [{ label: 'attw', value: 'package has no types' }],
    external: { message: 'package has no types', tool: 'attw' },
    fix: 'Publish type declarations or adjust the package entry/type metadata.',
    issueSink: options.issueSink,
    packageManifestPath: options.packageManifestPath,
    packageName: options.packageName,
    reason: 'ATTW could not find package types.',
    rootDir: options.rootDir,
    summary: 'ATTW could not find package types.',
    title: 'ATTW package issue',
    tool: 'attw',
  });
}

function finishNoTypes(options: {
  checkOptions: AttwCheckOptions;
  elapsed: ReturnType<typeof createElapsedTimer>;
  task: AttwTask | undefined;
}): PackageToolCheckResult {
  addNoTypesIssue(options.checkOptions);
  PackageLogger.error(
    `[${options.checkOptions.label}] [attw] package has no types`,
  );
  const message = `attw failed: ${options.checkOptions.label}`;
  PackageLogger.error(message, options.elapsed());
  failTask(options.task, message);
  return 'failed';
}

function addAttwIssue(options: {
  checkOptions: AttwCheckOptions;
  message: string;
  problem: Problem;
}): void {
  if (options.checkOptions.config.level === 'warn') return;
  const formatted = formatAttwProblem(options.problem);
  addPackageCheckIssue({
    code: 'LIMINA_PACKAGE_ATTW',
    detailLines: [options.message],
    evidence: [{ label: 'attw', value: formatted }],
    external: {
      code: getAttwProblemRuleName(options.problem),
      message: formatted,
      tool: 'attw',
    },
    fix: 'Inspect the ATTW message and adjust package exports/types for consumer resolution.',
    fixSteps: [
      'Inspect the ATTW message for the failing entrypoint and resolution mode.',
      'Update package exports, types, or emitted declaration files for that consumer resolution.',
      'Rebuild the package output and rerun the package check.',
    ],
    issueSink: options.checkOptions.issueSink,
    packageManifestPath: options.checkOptions.packageManifestPath,
    packageName: options.checkOptions.packageName,
    reason: formatted,
    rootDir: options.checkOptions.rootDir,
    summary: formatted,
    title: 'ATTW package issue',
    tool: 'attw',
  });
}

function reportAttwProblem(problem: Problem, options: AttwCheckOptions): void {
  const message = `[${options.label}] [attw] ${formatAttwProblem(problem)}`;
  addAttwIssue({ checkOptions: options, message, problem });
  if (options.config.level === 'warn') {
    PackageLogger.warn(message);
    return;
  }
  PackageLogger.error(message);
}

function logPassedAttw(options: {
  checkOptions: AttwCheckOptions;
  elapsed: ReturnType<typeof createElapsedTimer>;
}): void {
  if (options.checkOptions.flow?.interactive === true) return;
  PackageLogger.success(
    `attw passed: ${options.checkOptions.label}`,
    options.elapsed(),
  );
}

function finishPassedAttw(options: {
  checkOptions: AttwCheckOptions;
  elapsed: ReturnType<typeof createElapsedTimer>;
  task: AttwTask | undefined;
}): PackageToolCheckResult {
  logPassedAttw(options);
  passTask(options.task);
  return 'passed';
}

function finishWarningProblems(options: {
  elapsed: ReturnType<typeof createElapsedTimer>;
  summary: string;
  task: AttwTask | undefined;
}): PackageToolCheckResult {
  PackageLogger.warn(options.summary, options.elapsed());
  passTask(options.task);
  return 'passed';
}

function finishErrorProblems(options: {
  elapsed: ReturnType<typeof createElapsedTimer>;
  summary: string;
  task: AttwTask | undefined;
}): PackageToolCheckResult {
  PackageLogger.error(options.summary, options.elapsed());
  failTask(options.task, options.summary);
  return 'failed';
}

function finishAttwProblems(options: {
  checkOptions: AttwCheckOptions;
  count: number;
  elapsed: ReturnType<typeof createElapsedTimer>;
  task: AttwTask | undefined;
}): PackageToolCheckResult {
  const summary = `attw found ${options.count} problem(s): ${options.checkOptions.label}`;
  const finish =
    options.checkOptions.config.level === 'warn'
      ? finishWarningProblems
      : finishErrorProblems;
  return finish({ elapsed: options.elapsed, summary, task: options.task });
}

type AttwPeer = Awaited<ReturnType<typeof loadAttwPeer>>;

function createTask(options: AttwCheckOptions): AttwTask | undefined {
  if (options.flow === undefined) return undefined;
  return options.flow.start(`attw: ${options.label}`, {
    depth: options.flowDepth ?? 0,
  });
}

function requireOptionalToolError(error: unknown) {
  if (!isLiminaOptionalToolMissingError(error)) throw error;
  return error;
}

function skipMissingPeer(options: {
  elapsed: ReturnType<typeof createElapsedTimer>;
  error: unknown;
  label: string;
  task: AttwTask | undefined;
}): null {
  const optionalError = requireOptionalToolError(options.error);
  const message = formatMissingOptionalToolSkipMessage(optionalError.toolName);
  PackageLogger.warn(`${message}: ${options.label}`, options.elapsed());
  if (options.task !== undefined) options.task.skip(message);
  return null;
}

async function resolveAttwPeer(options: {
  elapsed: ReturnType<typeof createElapsedTimer>;
  label: string;
  task: AttwTask | undefined;
}): Promise<AttwPeer | null> {
  try {
    return await loadAttwPeer();
  } catch (error) {
    return skipMissingPeer({ ...options, error });
  }
}

function createCheckOptions(
  config: PackageAttwCheckConfig,
): CheckPackageOptions {
  return {
    entrypoints: config.entrypoints,
    entrypointsLegacy: config.entrypointsLegacy,
    excludeEntrypoints: config.excludeEntrypoints,
    includeEntrypoints: config.includeEntrypoints,
  };
}

function isIgnoredResolution(
  problem: Problem,
  ignoredResolutions: readonly string[],
): boolean {
  return (
    'resolutionKind' in problem &&
    ignoredResolutions.includes(problem.resolutionKind)
  );
}

function shouldKeepProblem(options: {
  ignoredResolutions: readonly string[];
  ignoredRuleNames: ReadonlySet<string>;
  problem: Problem;
}): boolean {
  return (
    !isIgnoredResolution(options.problem, options.ignoredResolutions) &&
    !options.ignoredRuleNames.has(getAttwProblemRuleName(options.problem))
  );
}

function collectRelevantProblems(options: {
  config: PackageAttwCheckConfig;
  problems: readonly Problem[];
  profile: PackageAttwProfile;
}): Problem[] {
  const ignoredResolutions = ATTW_PROFILE_IGNORED_RESOLUTIONS[options.profile];
  const ignoredRuleNames = new Set(options.config.ignoreRules);
  return options.problems.filter((problem) =>
    shouldKeepProblem({ ignoredResolutions, ignoredRuleNames, problem }),
  );
}

function reportProblems(
  problems: readonly Problem[],
  options: AttwCheckOptions,
): void {
  for (const problem of problems) reportAttwProblem(problem, options);
}

function finishProblemResult(options: {
  checkOptions: AttwCheckOptions;
  elapsed: ReturnType<typeof createElapsedTimer>;
  problems: readonly Problem[];
  task: AttwTask | undefined;
}): PackageToolCheckResult {
  reportProblems(options.problems, options.checkOptions);
  return finishAttwProblems({
    checkOptions: options.checkOptions,
    count: options.problems.length,
    elapsed: options.elapsed,
    task: options.task,
  });
}

async function executeTypedAttw(options: {
  checkOptions: AttwCheckOptions;
  elapsed: ReturnType<typeof createElapsedTimer>;
  peer: AttwPeer;
  task: AttwTask | undefined;
}): Promise<PackageToolCheckResult> {
  const package_ = options.peer.createPackageFromTarballData(
    options.checkOptions.tarball,
  );
  const result = await options.peer.checkPackage(
    package_,
    createCheckOptions(options.checkOptions.config),
  );
  if (!result.types) return finishNoTypes(options);
  const problems = collectRelevantProblems({
    config: options.checkOptions.config,
    problems: result.problems,
    profile: options.checkOptions.profile,
  });
  return problems.length === 0
    ? finishPassedAttw(options)
    : finishProblemResult({ ...options, problems });
}

export async function runAttwCheck(
  options: AttwCheckOptions,
): Promise<PackageToolCheckResult> {
  const task = createTask(options);
  const elapsed = createElapsedTimer();
  const peer = await resolveAttwPeer({
    elapsed,
    label: options.label,
    task,
  });
  if (peer === null) return 'skipped';
  PackageLogger.info(
    `attw started: ${options.label} (profile: ${options.profile})`,
  );
  return executeTypedAttw({ checkOptions: options, elapsed, peer, task });
}
