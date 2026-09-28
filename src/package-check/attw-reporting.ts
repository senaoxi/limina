import type {
  PackageAttwCheckConfig,
  PackageAttwProfile,
} from '#config/runner';
import type { Problem } from '@arethetypeswrong/core';
import type { createElapsedTimer } from 'logaria/helper';
import type { LiminaCheckIssue } from '../check-reporting/snapshot';
import type { LiminaFlowReporter } from '../flow';
import { PackageLogger } from '../logger';
import { formatAttwProblem, getAttwProblemRuleName } from './attw-format';
import { addPackageCheckIssue } from './issue';
import type { PackageToolCheckResult } from './runner-types';

export interface AttwCheckOptions {
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

export type AttwTask = ReturnType<NonNullable<LiminaFlowReporter['start']>>;

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

export function finishNoTypes(options: {
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

export function reportAttwProblem(
  problem: Problem,
  options: AttwCheckOptions,
): void {
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

export function finishPassedAttw(options: {
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

export function finishAttwProblems(options: {
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
