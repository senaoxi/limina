import { shouldUseColor } from '#utils/reporting';
import type { CheckIssueReportOptions } from '../check-reporting/human';
import { formatCheckIssueHumanReport } from '../check-reporting/human';
import {
  appendCheckIssues,
  type LiminaCheckIssue,
} from '../check-reporting/snapshot';
import type { LiminaArtifactNamespace } from '../domain/artifacts/namespace';
import type { TaskProgressReporter } from '../execution/progress';
import type { LiminaFlowReporter } from '../flow';
import { clearCliScreen, GraphLogger } from '../logger';

export interface GraphCommandOptionsBase {
  clearScreen?: boolean;
  deferSnapshot?: boolean;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  issues?: LiminaCheckIssue[];
  progress?: TaskProgressReporter;
  report?: CheckIssueReportOptions;
}

export interface GraphCommandTask {
  fail(reason: string, details?: { error: unknown }): void;
  pass(): void;
}

export function isGraphReportDeferred(
  options: GraphCommandOptionsBase,
): boolean {
  const report = options.report;
  return report === undefined ? false : report.defer === true;
}

export function isGraphInteractiveFlow(
  options: GraphCommandOptionsBase,
): boolean {
  const flow = options.flow;
  return flow === undefined ? false : flow.interactive === true;
}

export function isGraphSnapshotDeferred(
  options: GraphCommandOptionsBase,
): boolean {
  return options.deferSnapshot === true;
}

function shouldClearScreen(options: GraphCommandOptionsBase): boolean {
  return options.clearScreen === undefined ? true : options.clearScreen;
}

function getFlowDepth(options: GraphCommandOptionsBase): number {
  return options.flowDepth === undefined ? 0 : options.flowDepth;
}

export function createGraphCommandTask(
  options: GraphCommandOptionsBase,
  label: string,
): GraphCommandTask | undefined {
  if (options.progress !== undefined) {
    return undefined;
  }

  const flow = options.flow;
  return flow === undefined
    ? undefined
    : flow.start(label, { depth: getFlowDepth(options) });
}

export function prepareGraphCommand(options: GraphCommandOptionsBase): void {
  if (shouldClearScreen(options)) {
    clearCliScreen();
  }
}

function appendDeferredIssues(
  target: LiminaCheckIssue[] | undefined,
  issues: readonly LiminaCheckIssue[],
): void {
  if (target !== undefined) {
    target.push(...issues);
  }
}

export async function persistGraphIssues(options: {
  artifactNamespace: LiminaArtifactNamespace;
  commandOptions: GraphCommandOptionsBase;
  issues: readonly LiminaCheckIssue[];
  rootDir: string;
}): Promise<void> {
  if (isGraphSnapshotDeferred(options.commandOptions)) {
    appendDeferredIssues(options.commandOptions.issues, options.issues);
    return;
  }

  await appendCheckIssues({
    artifactNamespace: options.artifactNamespace,
    issues: options.issues,
    rootDir: options.rootDir,
  });
}

function getReportCommand(
  options: GraphCommandOptionsBase,
  fallback: string,
): string {
  const report = options.report;
  const command = report === undefined ? undefined : report.command;
  return command === undefined ? fallback : command;
}

function getReportVerbose(
  options: GraphCommandOptionsBase,
): boolean | undefined {
  const report = options.report;
  return report === undefined ? undefined : report.verbose;
}

export function logGraphIssueReport(options: {
  command: string;
  commandOptions: GraphCommandOptionsBase;
  issues: readonly LiminaCheckIssue[];
  title: string;
}): void {
  if (isGraphReportDeferred(options.commandOptions)) {
    return;
  }

  GraphLogger.error(
    formatCheckIssueHumanReport({
      color: shouldUseColor(),
      command: getReportCommand(options.commandOptions, options.command),
      issues: options.issues,
      title: options.title,
      verbose: getReportVerbose(options.commandOptions),
    }),
  );
}

export function shouldLogGraphSuccess(
  options: GraphCommandOptionsBase,
): boolean {
  return [
    !isGraphReportDeferred(options),
    !isGraphInteractiveFlow(options),
  ].every(Boolean);
}

export function passGraphTask(task: GraphCommandTask | undefined): void {
  task?.pass();
}

export function failGraphTask(
  task: GraphCommandTask | undefined,
  reason: string,
  details?: { error: unknown },
): void {
  if (task === undefined) {
    return;
  }

  if (details === undefined) {
    task.fail(reason);
    return;
  }

  task.fail(reason, details);
}
