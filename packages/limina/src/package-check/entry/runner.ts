import type { PackageAttwProfile, PackageEntry } from '#config/runner';
import { toRelativePath } from '#utils/path';
import path from 'pathe';
import { formatErrorMessage, PackageLogger } from '../../logger';
import { runAttwCheck } from '../attw-check';
import { isRunBoundaryCheck } from '../boundary-check';
import { addPackageCheckIssue } from '../issue';
import {
  collectBuiltPackageManifestProblems,
  type DistPackageJson as DistributionPackageJson,
} from '../manifest';
import { runPublintCheck } from '../publint-check';
import type {
  PackageToolCheckResult,
  PackedPackageTarball,
  RunPackageCheckEntryOptions,
} from '../runner-types';
import { readDistributionPackageJson } from '../tarball';
import {
  getPackageAttwCheckConfig,
  getPackagePublintCheckConfig,
} from '../tool-config';
import { prepareEntryTarball } from './tarball';

interface EntryExecutionState {
  checkedToolCount: number;
  packedDist?: PackedPackageTarball;
  passed: boolean;
  skippedToolCount: number;
}

function createEntryExecutionState(): EntryExecutionState {
  return {
    checkedToolCount: 0,
    passed: true,
    skippedToolCount: 0,
  };
}

function applyToolResult(
  state: EntryExecutionState,
  result: PackageToolCheckResult,
): void {
  if (result === 'skipped') {
    state.skippedToolCount += 1;
    return;
  }
  state.checkedToolCount += 1;
  if (result === 'failed') state.passed = false;
}

function requireTarball(state: EntryExecutionState): Buffer {
  const packedDistribution = state.packedDist;
  if (packedDistribution === undefined) {
    throw new Error('Package tool requires a packed tarball.');
  }
  return packedDistribution.tarball;
}

function getProblemSummary(problem: string): string {
  const summary = problem.split('\n', 1)[0];
  return summary === undefined ? 'Built package manifest is invalid.' : summary;
}

function reportManifestProblem(options: {
  outputPackageJsonPath: string;
  packageName: string | undefined;
  problem: string;
  runOptions: RunPackageCheckEntryOptions;
}): void {
  const summary = getProblemSummary(options.problem);
  addPackageCheckIssue({
    code: 'LIMINA_PACKAGE_MANIFEST_INVALID',
    detailLines: options.problem.split('\n'),
    evidence: [
      { label: 'manifest diagnostic', lines: options.problem.split('\n') },
    ],
    fix: 'Fix the built package manifest before publishing or checking the package output.',
    fixSteps: [
      'Fix the built package manifest field reported in the diagnostic.',
      'Rebuild the package output.',
      'Rerun the package check.',
    ],
    issueSink: options.runOptions.issueSink,
    packageManifestPath: options.outputPackageJsonPath,
    packageName: options.packageName,
    reason: summary,
    rootDir: options.runOptions.config.rootDir,
    summary,
    title: 'Built package manifest issue',
    tool: 'manifest',
  });
  PackageLogger.error(options.problem);
}

function isReportManifestProblems(options: {
  manifest: DistributionPackageJson;
  outputPackageJsonPath: string;
  runOptions: RunPackageCheckEntryOptions;
}): boolean {
  const problems = collectBuiltPackageManifestProblems({
    label: options.runOptions.label,
    manifest: options.manifest,
    packageJsonPath: toRelativePath(
      options.runOptions.config.rootDir,
      options.outputPackageJsonPath,
    ),
  });
  for (const problem of problems) {
    reportManifestProblem({
      outputPackageJsonPath: options.outputPackageJsonPath,
      packageName: options.manifest.name,
      problem,
      runOptions: options.runOptions,
    });
  }
  return problems.length === 0;
}

interface EntryToolOptions {
  entry: PackageEntry;
  manifest: DistributionPackageJson;
  manifestPath: string;
  runOptions: RunPackageCheckEntryOptions;
  state: EntryExecutionState;
}

function isEnabled(
  options: EntryToolOptions,
  tool: 'attw' | 'boundary' | 'publint',
): boolean {
  return options.runOptions.checks.includes(tool);
}

function getToolDepth(options: EntryToolOptions): number {
  return (options.runOptions.flowDepth ?? 0) + 1;
}

async function runPublint(options: EntryToolOptions): Promise<void> {
  if (!isEnabled(options, 'publint')) return;
  const result = await runPublintCheck({
    config: getPackagePublintCheckConfig(options.entry),
    flow: options.runOptions.flow,
    flowDepth: getToolDepth(options),
    issueSink: options.runOptions.issueSink,
    label: options.runOptions.label,
    packageManifestPath: options.manifestPath,
    packageName: options.manifest.name,
    rootDir: options.runOptions.config.rootDir,
    tarball: requireTarball(options.state),
  });
  applyToolResult(options.state, result);
}

function getAttwProfile(options: {
  configuredProfile: PackageAttwProfile | undefined;
  requestedProfile: PackageAttwProfile | undefined;
}): PackageAttwProfile {
  if (options.requestedProfile !== undefined) return options.requestedProfile;
  return options.configuredProfile === undefined
    ? 'esm-only'
    : options.configuredProfile;
}

async function runAttw(options: EntryToolOptions): Promise<void> {
  if (!isEnabled(options, 'attw')) return;
  const config = getPackageAttwCheckConfig(options.entry);
  const profile = getAttwProfile({
    configuredProfile: config.profile,
    requestedProfile: options.runOptions.attwProfile,
  });
  const result = await runAttwCheck({
    config,
    flow: options.runOptions.flow,
    flowDepth: getToolDepth(options),
    issueSink: options.runOptions.issueSink,
    label: options.runOptions.label,
    packageManifestPath: options.manifestPath,
    packageName: options.manifest.name,
    profile,
    rootDir: options.runOptions.config.rootDir,
    tarball: requireTarball(options.state),
  });
  applyToolResult(options.state, result);
}

async function runBoundary(options: EntryToolOptions): Promise<void> {
  if (!isEnabled(options, 'boundary')) return;
  const isPassed = await isRunBoundaryCheck({
    checkOptions: {
      flow: options.runOptions.flow,
      flowDepth: getToolDepth(options),
      issueSink: options.runOptions.issueSink,
      packageManifestPath: options.manifestPath,
      packageName: options.manifest.name,
      rootDir: options.runOptions.config.rootDir,
    },
    label: options.runOptions.label,
    target: { ...options.entry.boundary, outDir: options.entry.outDir },
  });
  applyToolResult(options.state, isPassed ? 'passed' : 'failed');
}

async function runEntryTools(options: EntryToolOptions): Promise<void> {
  await runPublint(options);
  await runAttw(options);
  await runBoundary(options);
}

type EntryTask = ReturnType<
  NonNullable<RunPackageCheckEntryOptions['flow']>['start']
>;

type EntryResult = Pick<
  EntryExecutionState,
  'checkedToolCount' | 'passed' | 'skippedToolCount'
>;

function createEntry(options: RunPackageCheckEntryOptions): PackageEntry {
  return { ...options.rawEntry, outDir: options.outDir };
}

function getFlowDepth(options: RunPackageCheckEntryOptions): number {
  return options.flowDepth === undefined ? 0 : options.flowDepth;
}

function canCreateEntryTask(options: RunPackageCheckEntryOptions): boolean {
  return options.progressItem === undefined && options.flow !== undefined;
}

function createEntryTask(
  options: RunPackageCheckEntryOptions,
): EntryTask | undefined {
  if (!canCreateEntryTask(options)) return undefined;
  return options.flow!.start(`package entry: ${options.label}`, {
    depth: getFlowDepth(options),
  });
}

function shouldLogEntrySuccess(options: RunPackageCheckEntryOptions): boolean {
  return options.flow === undefined || !options.flow.interactive;
}

function passEntry(options: {
  runOptions: RunPackageCheckEntryOptions;
  task: EntryTask | undefined;
}): void {
  if (shouldLogEntrySuccess(options.runOptions)) {
    PackageLogger.success(`package checks passed: ${options.runOptions.label}`);
  }
  if (options.task !== undefined) options.task.pass();
}

function failEntry(options: {
  runOptions: RunPackageCheckEntryOptions;
  task: EntryTask | undefined;
}): void {
  const message = `package checks failed: ${options.runOptions.label}`;
  PackageLogger.error(message);
  if (options.task !== undefined) options.task.fail(message);
}

function finishEntry(options: {
  runOptions: RunPackageCheckEntryOptions;
  state: EntryExecutionState;
  task: EntryTask | undefined;
}): void {
  const finish = options.state.passed ? passEntry : failEntry;
  finish({ runOptions: options.runOptions, task: options.task });
}

async function executeEntry(options: {
  entry: PackageEntry;
  manifestPath: string;
  runOptions: RunPackageCheckEntryOptions;
  state: EntryExecutionState;
}): Promise<void> {
  const manifest = await readDistributionPackageJson({
    config: options.runOptions.config,
    label: options.runOptions.label,
    packageJsonPath: options.manifestPath,
  });
  options.state.passed = isReportManifestProblems({
    manifest,
    outputPackageJsonPath: options.manifestPath,
    runOptions: options.runOptions,
  });
  options.state.packedDist = await prepareEntryTarball({
    entry: options.entry,
    runOptions: options.runOptions,
  });
  await runEntryTools({
    entry: options.entry,
    manifest,
    manifestPath: options.manifestPath,
    runOptions: options.runOptions,
    state: options.state,
  });
}

function reportEntryFailure(options: {
  error: unknown;
  runOptions: RunPackageCheckEntryOptions;
  task: EntryTask | undefined;
}): never {
  const message = `package checks failed: ${options.runOptions.label}`;
  PackageLogger.error(`${message}: ${formatErrorMessage(options.error)}`);
  if (options.task !== undefined) {
    options.task.fail(message, { error: options.error });
  }
  throw options.error;
}

async function cleanupEntry(state: EntryExecutionState): Promise<void> {
  const packedDistribution = state.packedDist;
  if (packedDistribution !== undefined) await packedDistribution.cleanup();
}

export async function runPackageCheckEntry(
  options: RunPackageCheckEntryOptions,
): Promise<EntryResult> {
  const entry = createEntry(options);
  const task = createEntryTask(options);
  const state = createEntryExecutionState();
  try {
    await executeEntry({
      entry,
      manifestPath: path.join(entry.outDir, 'package.json'),
      runOptions: options,
      state,
    });
    finishEntry({ runOptions: options, state, task });
    return state;
  } catch (error) {
    return reportEntryFailure({ error, runOptions: options, task });
  } finally {
    await cleanupEntry(state);
  }
}
