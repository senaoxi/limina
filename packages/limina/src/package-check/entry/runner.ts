import type { PackageEntry } from '#config/runner';
import path from 'pathe';
import { formatErrorMessage, PackageLogger } from '../../logger';
import type { RunPackageCheckEntryOptions } from '../runner-types';
import { readDistPackageJson } from '../tarball';
import { reportManifestProblems } from './manifest';
import { createEntryExecutionState, type EntryExecutionState } from './state';
import { prepareEntryTarball } from './tarball';
import { runEntryTools } from './tools';

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
  if (options.progressItem !== undefined) return false;
  return options.flow !== undefined;
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
  if (options.flow === undefined) return true;
  return options.flow.interactive !== true;
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
  const manifest = await readDistPackageJson({
    config: options.runOptions.config,
    label: options.runOptions.label,
    packageJsonPath: options.manifestPath,
  });
  options.state.passed = reportManifestProblems({
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
  const packedDist = state.packedDist;
  if (packedDist !== undefined) await packedDist.cleanup();
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
