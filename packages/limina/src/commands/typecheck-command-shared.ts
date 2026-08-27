import { shouldUseColor } from '#utils/reporting';
import type { createElapsedTimer } from 'logaria/helper';
import type { CheckIssueReportOptions } from '../check-reporting/human';
import { formatCheckIssueHumanReport } from '../check-reporting/human';
import {
  appendCheckIssues,
  completeCheckIssueSnapshot,
  type LiminaCheckIssue,
} from '../check-reporting/snapshot';
import type { LiminaArtifactNamespace } from '../domain/artifacts/namespace';
import type { TaskProgressReporter } from '../execution/progress';
import type { LiminaFlowReporter } from '../flow';
import { clearCliScreen, TypecheckLogger } from '../logger';

export interface DeferredCheckIssueOptions {
  deferSnapshot?: boolean;
  issues?: LiminaCheckIssue[];
}

export interface TypecheckLifecycleOptions extends DeferredCheckIssueOptions {
  clearScreen?: boolean;
  config: { rootDir: string };
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  progress?: TaskProgressReporter;
  report?: CheckIssueReportOptions;
}

export interface TypecheckCommandTask {
  fail(reason: string, details?: { error: unknown }): void;
  pass(): void;
  skip(reason: string): void;
}

export function isTypecheckReportDeferred(
  options: TypecheckLifecycleOptions,
): boolean {
  return options.report?.defer === true;
}

export function getTypecheckReportCommand(
  options: TypecheckLifecycleOptions,
  fallback: string,
): string {
  return options.report?.command ?? fallback;
}

export function getTypecheckReportVerbose(
  options: TypecheckLifecycleOptions,
): boolean | undefined {
  return options.report?.verbose;
}

function shouldClearTypecheckScreen(
  lifecycle: TypecheckLifecycleOptions,
): boolean {
  return lifecycle.clearScreen !== false;
}

function shouldLogTypecheckStart(
  lifecycle: TypecheckLifecycleOptions,
): boolean {
  return !isTypecheckReportDeferred(lifecycle) && lifecycle.flow === undefined;
}

export function initializeTypecheckCommand(options: {
  label: string;
  lifecycle: TypecheckLifecycleOptions;
}): void {
  if (shouldClearTypecheckScreen(options.lifecycle)) {
    clearCliScreen();
  }

  if (shouldLogTypecheckStart(options.lifecycle)) {
    TypecheckLogger.info(`${options.label} started`);
  }
}

function getFlowDepth(options: TypecheckLifecycleOptions): number {
  return options.flowDepth ?? 0;
}

function shouldSuppressTypecheckTask(options: {
  lifecycle: TypecheckLifecycleOptions;
  suppressForProgress: boolean;
}): boolean {
  return (
    options.suppressForProgress && options.lifecycle.progress !== undefined
  );
}

export function createTypecheckTask(options: {
  label: string;
  lifecycle: TypecheckLifecycleOptions;
  suppressForProgress: boolean;
}): TypecheckCommandTask | undefined {
  if (shouldSuppressTypecheckTask(options)) {
    return undefined;
  }

  if (options.lifecycle.flow === undefined) {
    return undefined;
  }

  return options.lifecycle.flow.start(options.label, {
    depth: getFlowDepth(options.lifecycle),
  });
}

export function passTypecheckTask(
  task: TypecheckCommandTask | undefined,
): void {
  task?.pass();
}

export function disableTypecheckTask(
  task: TypecheckCommandTask | undefined,
): void {
  task?.skip('disabled: no framework targets');
}

export function failTypecheckTask(options: {
  details?: { error: unknown };
  reason: string;
  task: TypecheckCommandTask | undefined;
}): void {
  options.task?.fail(options.reason, options.details);
}

export async function collectCheckIssues(options: {
  artifactNamespace: LiminaArtifactNamespace;
  deferSnapshot?: boolean;
  issueSink?: LiminaCheckIssue[];
  issues: readonly LiminaCheckIssue[];
  rootDir: string;
}): Promise<void> {
  if (options.deferSnapshot === true) {
    options.issueSink?.push(...options.issues);
    return;
  }

  await appendCheckIssues({
    artifactNamespace: options.artifactNamespace,
    issues: options.issues,
    rootDir: options.rootDir,
  });
}

export async function completeCheckSnapshotIfNeeded(options: {
  artifactNamespace: LiminaArtifactNamespace;
  deferSnapshot?: boolean;
  rootDir: string;
}): Promise<void> {
  if (options.deferSnapshot === true) {
    return;
  }

  await completeCheckIssueSnapshot({
    artifactNamespace: options.artifactNamespace,
    rootDir: options.rootDir,
  });
}

export function logCheckerIssueReport(options: {
  command: string;
  elapsed: ReturnType<ReturnType<typeof createElapsedTimer>>;
  issues: readonly LiminaCheckIssue[];
  lifecycle: TypecheckLifecycleOptions;
  title: string;
}): void {
  if (isTypecheckReportDeferred(options.lifecycle)) {
    return;
  }

  TypecheckLogger.error(
    formatCheckIssueHumanReport({
      color: shouldUseColor(),
      command: options.command,
      issues: options.issues,
      title: options.title,
      verbose: getTypecheckReportVerbose(options.lifecycle),
    }),
    options.elapsed,
  );
}

export function shouldLogTypecheckSuccess(
  options: TypecheckLifecycleOptions,
): boolean {
  return [
    !isTypecheckReportDeferred(options),
    options.flow?.interactive !== true,
  ].every(Boolean);
}
