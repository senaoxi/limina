import { createElapsedTimer } from 'logaria/helper';
import path from 'pathe';
import type { LiminaCheckIssue } from '../check-reporting/snapshot';
import type { LiminaFlowReporter } from '../flow';
import { PackageLogger } from '../logger';
import { addPackageCheckIssue } from './issue';
import { auditPublishedPackageBoundaries } from './published-boundary';
import type {
  PublishedPackageBoundaryTarget,
  PublishedPackageBoundaryViolation,
} from './runner-types';

interface BoundaryCheckOptions {
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  issueSink?: LiminaCheckIssue[];
  packageManifestPath: string;
  packageName?: string;
  rootDir: string;
}

type BoundaryTask = ReturnType<NonNullable<LiminaFlowReporter['start']>>;

function createTask(options: {
  checkOptions: BoundaryCheckOptions;
  label: string;
}): BoundaryTask | undefined {
  if (options.checkOptions.flow === undefined) return undefined;
  return options.checkOptions.flow.start(`package boundary: ${options.label}`, {
    depth: options.checkOptions.flowDepth ?? 0,
  });
}

function formatViolation(
  label: string,
  violation: PublishedPackageBoundaryViolation,
): string {
  return `[${label}] [boundary] ${violation.filePath} (${violation.environment}) imports "${violation.specifier}": ${violation.message}`;
}

function addBoundaryIssue(options: {
  checkOptions: BoundaryCheckOptions;
  label: string;
  target: PublishedPackageBoundaryTarget;
  violation: PublishedPackageBoundaryViolation;
}): void {
  addPackageCheckIssue({
    code: 'LIMINA_PACKAGE_BOUNDARY',
    detailLines: [formatViolation(options.label, options.violation)],
    evidence: [
      {
        label: 'import',
        value: `${options.violation.filePath} imports "${options.violation.specifier}"`,
      },
      { label: 'environment', value: options.violation.environment },
    ],
    filePath: path.resolve(options.target.outDir, options.violation.filePath),
    fix: 'Remove the import, change the package boundary config, or move the code to an environment that allows this dependency.',
    fixSteps: [
      'Remove the disallowed import from the published output.',
      'Move the code to an environment where the dependency is allowed, or adjust the package boundary config.',
      'Rebuild the package output and rerun the package check.',
    ],
    issueSink: options.checkOptions.issueSink,
    packageManifestPath: options.checkOptions.packageManifestPath,
    packageName: options.checkOptions.packageName,
    reason: options.violation.message,
    rootDir: options.checkOptions.rootDir,
    summary: `${options.violation.filePath} imports "${options.violation.specifier}" in ${options.violation.environment}.`,
    title: 'Published package boundary issue',
    tool: 'boundary',
  });
}

function reportViolations(options: {
  checkOptions: BoundaryCheckOptions;
  label: string;
  target: PublishedPackageBoundaryTarget;
  violations: readonly PublishedPackageBoundaryViolation[];
}): void {
  for (const violation of options.violations) {
    addBoundaryIssue({ ...options, violation });
    PackageLogger.error(formatViolation(options.label, violation));
  }
}

function passBoundaryTask(task: BoundaryTask | undefined): void {
  if (task !== undefined) task.pass();
}

function failBoundaryTask(
  task: BoundaryTask | undefined,
  message: string,
): void {
  if (task !== undefined) task.fail(message);
}

function finishPassedBoundary(options: {
  checkOptions: BoundaryCheckOptions;
  elapsed: ReturnType<typeof createElapsedTimer>;
  label: string;
  task: BoundaryTask | undefined;
}): boolean {
  if (options.checkOptions.flow?.interactive !== true) {
    PackageLogger.success(
      `package boundary passed: ${options.label}`,
      options.elapsed(),
    );
  }
  passBoundaryTask(options.task);
  return true;
}

function finishFailedBoundary(options: {
  count: number;
  elapsed: ReturnType<typeof createElapsedTimer>;
  label: string;
  task: BoundaryTask | undefined;
}): boolean {
  const summary = `package boundary found ${options.count} issue(s): ${options.label}`;
  PackageLogger.error(summary, options.elapsed());
  failBoundaryTask(options.task, summary);
  return false;
}

export async function runBoundaryCheck(options: {
  checkOptions: BoundaryCheckOptions;
  label: string;
  target: PublishedPackageBoundaryTarget;
}): Promise<boolean> {
  const task = createTask(options);
  PackageLogger.info(`package boundary started: ${options.label}`);
  const elapsed = createElapsedTimer();
  const violations = await auditPublishedPackageBoundaries(options.target);
  if (violations.length === 0) {
    return finishPassedBoundary({ ...options, elapsed, task });
  }
  reportViolations({ ...options, violations });
  return finishFailedBoundary({
    count: violations.length,
    elapsed,
    label: options.label,
    task,
  });
}
