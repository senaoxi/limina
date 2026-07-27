import { toRelativePath } from '#utils/path';
import { createElapsedTimer } from 'logaria/helper';
import path from 'pathe';
import { clearCliScreen, ReleaseLogger } from '../../logger';
import type { PackageEntrySelectionPlan } from '../../package-check/runner';
import { type LiminaPreflightManager, resolvePreflight } from '../../preflight';
import type { RunReleaseCheckOptions } from './types';

export interface ReleaseCommandTask {
  fail(reason: string, details?: { error: unknown }): void;
  pass(): void;
}

export interface ReleaseCommandContext {
  cwd: string;
  elapsed: ReturnType<typeof createElapsedTimer>;
  options: RunReleaseCheckOptions;
  preflight: LiminaPreflightManager;
  task: ReleaseCommandTask | undefined;
}

export function isReleaseReportDeferred(
  options: RunReleaseCheckOptions,
): boolean {
  return options.report?.defer === true;
}

export function isReleaseSnapshotDeferred(
  options: RunReleaseCheckOptions,
): boolean {
  return options.deferSnapshot === true;
}

export function isReleaseInteractiveFlow(
  options: RunReleaseCheckOptions,
): boolean {
  return options.flow?.interactive === true;
}

export function getSingleReleasePackageName(
  options: RunReleaseCheckOptions,
): string | undefined {
  const packageNames = options.packageNames;

  if (packageNames === undefined) {
    return undefined;
  }

  return packageNames.length === 1 ? packageNames[0] : undefined;
}

export function getReleaseReportCommand(
  options: RunReleaseCheckOptions,
): string {
  return options.report?.command ?? 'limina release check';
}

export function getReleaseReportVerbose(
  options: RunReleaseCheckOptions,
): boolean | undefined {
  return options.report?.verbose;
}

function shouldClearScreen(options: RunReleaseCheckOptions): boolean {
  return options.clearScreen !== false;
}

function getFlowDepth(options: RunReleaseCheckOptions): number {
  return options.flowDepth ?? 0;
}

function createReleaseTask(
  options: RunReleaseCheckOptions,
): ReleaseCommandTask | undefined {
  if (options.progress !== undefined) {
    return undefined;
  }

  if (options.flow === undefined) {
    return undefined;
  }

  return options.flow.start('release check', {
    depth: getFlowDepth(options),
  });
}

function logReleaseStart(options: RunReleaseCheckOptions): void {
  if (!isReleaseReportDeferred(options)) {
    ReleaseLogger.info('release check started');
  }
}

export function createReleaseCommandContext(
  options: RunReleaseCheckOptions,
): ReleaseCommandContext {
  if (shouldClearScreen(options)) {
    clearCliScreen();
  }

  logReleaseStart(options);
  return {
    cwd: path.resolve(options.cwd ?? process.cwd()),
    elapsed: createElapsedTimer(),
    options,
    preflight: resolvePreflight(options.config, options),
    task: createReleaseTask(options),
  };
}

export function logReleaseCheckPlan(options: {
  config: RunReleaseCheckOptions['config'];
  cwd: string;
  plan: PackageEntrySelectionPlan;
}): void {
  const entryLines = options.plan.entries.map((entry) =>
    [
      `    - ${entry.label}`,
      `      outDir: ${toRelativePath(options.config.rootDir, entry.outDir)}`,
    ].join('\n'),
  );
  ReleaseLogger.info(
    [
      'Release check plan:',
      `  config: ${toRelativePath(options.config.rootDir, options.config.configPath)}`,
      `  cwd: ${toRelativePath(options.config.rootDir, options.cwd)}`,
      `  selection: ${options.plan.selectionReason}`,
      '  entries:',
      ...entryLines,
    ].join('\n'),
  );
}
