import { createElapsedTimer } from 'logaria/helper';
import type { LiminaFlowReporter } from '../../flow';
import { formatErrorMessage, ReleaseLogger } from '../../logger';
import {
  type PackedPackageTarball,
  packOutputTarball,
} from '../../package-check/runner';
import type { ReleaseEntryOptions } from './types';

interface ReleaseTarballTask {
  fail(reason: string, details?: { error: unknown }): void;
  pass(): void;
}

function getFlowDepth(depth: number | undefined): number {
  return depth === undefined ? 0 : depth;
}

function createTarballTask(
  flow: LiminaFlowReporter | undefined,
  label: string,
  depth: number | undefined,
): ReleaseTarballTask | undefined {
  if (flow === undefined) {
    return undefined;
  }

  return flow.start(`release tarball: ${label}`, {
    depth: getFlowDepth(depth) + 1,
  });
}

function logPackSuccess(
  entry: ReleaseEntryOptions,
  elapsed: ReturnType<typeof createElapsedTimer>,
): void {
  if (entry.flow?.interactive === true) {
    return;
  }

  ReleaseLogger.success(`release tarball packed: ${entry.label}`, elapsed());
}

function handlePackError(options: {
  elapsed: ReturnType<typeof createElapsedTimer>;
  entry: ReleaseEntryOptions;
  error: unknown;
  task: ReleaseTarballTask | undefined;
}): never {
  ReleaseLogger.error(
    `release tarball failed: ${options.entry.label}: ${formatErrorMessage(options.error)}`,
    options.elapsed(),
  );
  options.task?.fail(`release tarball failed: ${options.entry.label}`, {
    error: options.error,
  });
  throw options.error;
}

export async function packReleaseTarball(
  entry: ReleaseEntryOptions,
): Promise<PackedPackageTarball> {
  const task = createTarballTask(entry.flow, entry.label, entry.flowDepth);
  const elapsed = createElapsedTimer();
  ReleaseLogger.info(`release tarball packing started: ${entry.label}`);

  try {
    const packed = await packOutputTarball(entry.outDir);
    logPackSuccess(entry, elapsed);
    task?.pass();
    return packed;
  } catch (error) {
    return handlePackError({ elapsed, entry, error, task });
  }
}
