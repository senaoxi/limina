import type { PackageCheckTool, PackageEntry } from '#config/runner';
import { createElapsedTimer } from 'logaria/helper';
import { formatErrorMessage, PackageLogger } from '../../logger';
import type {
  PackedPackageTarball,
  RunPackageCheckEntryOptions,
} from '../runner-types';
import { packOutputTarball } from '../tarball';

type TarballTask = ReturnType<
  NonNullable<RunPackageCheckEntryOptions['flow']>['start']
>;

function needsPackedTarball(checks: readonly PackageCheckTool[]): boolean {
  return checks.some((check) => check === 'publint' || check === 'attw');
}

function noTarballTask(): undefined {
  return ([] as undefined[])[0];
}

function createTarballTask(
  options: RunPackageCheckEntryOptions,
): TarballTask | undefined {
  if (options.flow === undefined) return noTarballTask();
  return options.flow.start(`package tarball: ${options.label}`, {
    depth: (options.flowDepth ?? 0) + 1,
  });
}

function passTask(task: TarballTask | undefined): void {
  if (task !== undefined) task.pass();
}

function failTask(
  task: TarballTask | undefined,
  message: string,
  error: unknown,
): void {
  if (task !== undefined) task.fail(message, { error });
}

function logPacked(options: {
  elapsed: ReturnType<typeof createElapsedTimer>;
  runOptions: RunPackageCheckEntryOptions;
}): void {
  if (options.runOptions.flow?.interactive === true) return;
  PackageLogger.success(
    `package tarball packed: ${options.runOptions.label}`,
    options.elapsed(),
  );
}

function reportPacked(options: {
  elapsed: ReturnType<typeof createElapsedTimer>;
  runOptions: RunPackageCheckEntryOptions;
  task: TarballTask | undefined;
}): void {
  logPacked(options);
  passTask(options.task);
}

function reportPackFailure(options: {
  elapsed: ReturnType<typeof createElapsedTimer>;
  error: unknown;
  runOptions: RunPackageCheckEntryOptions;
  task: TarballTask | undefined;
}): never {
  const message = `package tarball failed: ${options.runOptions.label}`;
  PackageLogger.error(
    `${message}: ${formatErrorMessage(options.error)}`,
    options.elapsed(),
  );
  failTask(options.task, message, options.error);
  throw options.error;
}

async function packEntryOutput(options: {
  entry: PackageEntry;
  runOptions: RunPackageCheckEntryOptions;
}): Promise<PackedPackageTarball> {
  const task = createTarballTask(options.runOptions);
  PackageLogger.info(
    `package tarball packing started: ${options.runOptions.label}`,
  );
  const elapsed = createElapsedTimer();
  try {
    const packed = await packOutputTarball(options.entry.outDir);
    reportPacked({ elapsed, runOptions: options.runOptions, task });
    return packed;
  } catch (error) {
    return reportPackFailure({
      elapsed,
      error,
      runOptions: options.runOptions,
      task,
    });
  }
}

function noPackedTarball(): Promise<undefined> {
  return Promise.resolve(([] as undefined[])[0]);
}

export function prepareEntryTarball(options: {
  entry: PackageEntry;
  runOptions: RunPackageCheckEntryOptions;
}): Promise<PackedPackageTarball | undefined> {
  if (!needsPackedTarball(options.runOptions.checks)) {
    return noPackedTarball();
  }
  return packEntryOutput(options);
}
