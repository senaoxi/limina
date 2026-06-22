import { createElapsedTimer } from 'logaria/helper';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import { formatCheckIssueHumanReport } from '../check-reporting/human';
import {
  appendCheckIssues,
  completeCheckIssueSnapshot,
  createTaskFailureIssue,
  type LiminaCheckIssue,
  type LiminaCheckTaskName,
} from '../check-reporting/snapshot';
import { clearCliScreen, formatErrorMessage, TypecheckLogger } from '../logger';
import {
  type CheckerFailureKind,
  type CheckerFailureTarget,
  runBuildImpl,
  type RunBuildOptions,
  type RunBuildResult,
  runCheckerBuildImpl,
  type RunCheckerBuildOptions,
  type RunCheckerBuildResult,
  runCheckerTypecheckImpl,
  type RunCheckerTypecheckOptions,
  type RunCheckerTypecheckResult,
} from '../typecheck/runner';

export type {
  RunBuildOptions,
  RunBuildResult,
  RunCheckerBuildOptions,
  RunCheckerBuildResult,
  RunCheckerTypecheckOptions,
  RunCheckerTypecheckResult,
} from '../typecheck/runner';
export type {
  TypecheckRunner,
  TypecheckTarget,
  TypecheckTargetResult,
} from '../typecheck/targets';

interface DeferredCheckIssueOptions {
  deferSnapshot?: boolean;
  issues?: LiminaCheckIssue[];
}

async function collectCheckIssues(options: {
  deferSnapshot?: boolean;
  issueSink?: LiminaCheckIssue[];
  issues: readonly LiminaCheckIssue[];
  rootDir: string;
}): Promise<void> {
  if (options.deferSnapshot) {
    options.issueSink?.push(...options.issues);
    return;
  }

  await appendCheckIssues({
    issues: options.issues,
    rootDir: options.rootDir,
  });
}

async function completeCheckSnapshotIfNeeded(
  options: DeferredCheckIssueOptions & { rootDir: string },
): Promise<void> {
  if (options.deferSnapshot) {
    return;
  }

  await completeCheckIssueSnapshot({
    rootDir: options.rootDir,
  });
}

function createCheckerFailureIssues(options: {
  failedTargets: readonly CheckerFailureTarget[];
  fallbackReason: string;
  failureKind?: CheckerFailureKind;
  fix: string;
  hideExecutionDetails?: boolean;
  projectRootDir: string;
  problems?: readonly string[];
  task: Extract<LiminaCheckTaskName, 'checker:build' | 'checker:typecheck'>;
  title: string;
}): LiminaCheckIssue[] {
  const defaultFailureCode =
    options.task === 'checker:build'
      ? LIMINA_CHECK_ISSUE_CODES.checkerBuildFailed
      : LIMINA_CHECK_ISSUE_CODES.checkerTypecheckFailed;
  const failureCode =
    options.failureKind === 'peer-dependency'
      ? LIMINA_CHECK_ISSUE_CODES.checkerPeerDependencyMissing
      : options.failureKind === 'target-selection'
        ? LIMINA_CHECK_ISSUE_CODES.checkerTargetSelectionFailed
        : defaultFailureCode;

  if (options.failedTargets.length === 0) {
    return [
      createTaskFailureIssue({
        code: failureCode,
        ...(!options.hideExecutionDetails && options.problems
          ? { detailLines: [...options.problems] }
          : {}),
        ...(!options.hideExecutionDetails && options.problems?.length
          ? {
              evidence: [
                {
                  label: 'checker diagnostic',
                  lines: [...options.problems],
                },
              ],
            }
          : {}),
        fix: options.fix,
        fixSteps: [options.fix],
        reason: options.hideExecutionDetails
          ? options.title
          : options.fallbackReason,
        rootDir: options.projectRootDir,
        ...(options.hideExecutionDetails ? { summary: options.title } : {}),
        task: options.task,
        title: options.title,
        verifyCommands: [
          options.task === 'checker:build'
            ? 'limina checker build'
            : 'limina checker typecheck',
        ],
      }),
    ];
  }

  return options.failedTargets.map((target) => {
    const message = options.hideExecutionDetails ? undefined : target.message;

    return createTaskFailureIssue({
      checkerName: target.checkerName,
      code: defaultFailureCode,
      evidence: [
        {
          label: 'exit code',
          value: String(target.exitCode),
        },
        ...(message ? [{ label: 'error', value: message }] : []),
      ],
      filePath: target.configPath,
      fix: options.fix,
      fixSteps: [options.fix],
      reason: [
        target.checkerName
          ? `Checker "${target.checkerName}" failed.`
          : 'Checker target failed.',
        `Exit code: ${target.exitCode}.`,
        ...(message ? [`Error: ${message}.`] : []),
      ].join(' '),
      rootDir: options.projectRootDir,
      ...(options.hideExecutionDetails ? { summary: options.title } : {}),
      task: options.task,
      title: options.title,
      verifyCommands: [
        options.task === 'checker:build'
          ? 'limina checker build'
          : 'limina checker typecheck',
      ],
    });
  });
}

function formatCheckerIssueReport(options: {
  command: string;
  issues: readonly LiminaCheckIssue[];
  title: string;
  verbose?: boolean;
}): string {
  return formatCheckIssueHumanReport({
    command: options.command,
    issues: options.issues,
    title: options.title,
    verbose: options.verbose,
  });
}

export async function runCheckerBuild(
  options: RunCheckerBuildOptions & DeferredCheckIssueOptions,
): Promise<RunCheckerBuildResult> {
  if (options.clearScreen ?? true) {
    clearCliScreen();
  }

  const elapsed = createElapsedTimer();
  const task = options.progress
    ? undefined
    : options.flow?.start('checker build', {
        depth: options.flowDepth ?? 0,
      });

  if (!options.report?.defer && !options.flow) {
    TypecheckLogger.info('checker build started');
  }

  try {
    const result = await runCheckerBuildImpl(options);

    if (result.passed) {
      await completeCheckSnapshotIfNeeded({
        deferSnapshot: options.deferSnapshot,
        issues: options.issues,
        rootDir: options.config.rootDir,
      });

      if (!options.report?.defer && !options.flow?.interactive) {
        TypecheckLogger.success('checker build finished', elapsed());
      }

      task?.pass();
    } else {
      const issues = createCheckerFailureIssues({
        failedTargets: result.failedTargets,
        fallbackReason: 'Checker build finished with failures.',
        failureKind: result.failureKind,
        fix: 'Inspect the checker build output above, then rerun `limina checker build` or `limina check`.',
        ...(options.report?.defer ? { hideExecutionDetails: true } : {}),
        projectRootDir: result.projectRootDir,
        problems: result.problems,
        task: 'checker:build',
        title: 'Checker build failed',
      });

      await collectCheckIssues({
        deferSnapshot: options.deferSnapshot,
        issueSink: options.issues,
        issues,
        rootDir: options.config.rootDir,
      });
      if (!options.report?.defer) {
        TypecheckLogger.error(
          formatCheckerIssueReport({
            command: options.report?.command ?? 'limina checker build',
            issues,
            title: 'Checker build summary',
            verbose: options.report?.verbose,
          }),
          elapsed(),
        );
      }
      task?.fail('checker build finished with failures');
    }
    return result;
  } catch (error) {
    const errorMessage = formatErrorMessage(error);
    const issue = createTaskFailureIssue({
      code: 'LIMINA_CHECKER_BUILD_FAILED',
      ...(options.report?.defer ? {} : { detailLines: [errorMessage] }),
      fix: 'Inspect the checker build error above, then rerun `limina checker build` or `limina check`.',
      reason: options.report?.defer
        ? 'Checker build failed.'
        : `Checker build failed: ${errorMessage}.`,
      rootDir: options.config.rootDir,
      ...(options.report?.defer ? { summary: 'Checker build failed' } : {}),
      task: 'checker:build',
      title: 'Checker build failed',
    });

    await collectCheckIssues({
      deferSnapshot: options.deferSnapshot,
      issueSink: options.issues,
      issues: [issue],
      rootDir: options.config.rootDir,
    });
    if (!options.report?.defer) {
      TypecheckLogger.error(
        formatCheckerIssueReport({
          command: options.report?.command ?? 'limina checker build',
          issues: [issue],
          title: 'Checker build summary',
          verbose: options.report?.verbose,
        }),
        elapsed(),
      );
    }
    task?.fail('checker build failed', { error });
    throw error;
  }
}

export async function runBuild(
  options: RunBuildOptions & DeferredCheckIssueOptions,
): Promise<RunBuildResult> {
  if (options.clearScreen ?? true) {
    clearCliScreen();
  }

  const elapsed = createElapsedTimer();
  const task = options.flow?.start('build', {
    depth: options.flowDepth ?? 0,
  });

  if (!options.report?.defer && !options.flow) {
    TypecheckLogger.info('build started');
  }

  try {
    const result = await runBuildImpl(options);

    if (result.passed) {
      await completeCheckSnapshotIfNeeded({
        deferSnapshot: options.deferSnapshot,
        issues: options.issues,
        rootDir: options.config.rootDir,
      });

      if (!options.report?.defer && !options.flow?.interactive) {
        TypecheckLogger.success('build finished', elapsed());
      }

      task?.pass();
    } else {
      const issues = createCheckerFailureIssues({
        failedTargets: result.failedTargets,
        fallbackReason: 'Checker build finished with failures.',
        failureKind: result.failureKind,
        fix: 'Inspect the checker build output above, then rerun `limina checker build`.',
        projectRootDir: result.projectRootDir,
        problems: result.problems,
        task: 'checker:build',
        title: 'Checker build failed',
      });

      await collectCheckIssues({
        deferSnapshot: options.deferSnapshot,
        issueSink: options.issues,
        issues,
        rootDir: options.config.rootDir,
      });
      if (!options.report?.defer) {
        TypecheckLogger.error(
          formatCheckerIssueReport({
            command: options.report?.command ?? 'limina checker build',
            issues,
            title: 'Build summary',
            verbose: options.report?.verbose,
          }),
          elapsed(),
        );
      }
      task?.fail('build finished with failures');
    }

    return result;
  } catch (error) {
    const issue = createTaskFailureIssue({
      code: 'LIMINA_CHECKER_BUILD_FAILED',
      detailLines: [formatErrorMessage(error)],
      fix: 'Inspect the build error above, then rerun `limina checker build`.',
      reason: `Checker build failed: ${formatErrorMessage(error)}.`,
      rootDir: options.config.rootDir,
      task: 'checker:build',
      title: 'Checker build failed',
    });

    await collectCheckIssues({
      deferSnapshot: options.deferSnapshot,
      issueSink: options.issues,
      issues: [issue],
      rootDir: options.config.rootDir,
    });
    if (!options.report?.defer) {
      TypecheckLogger.error(
        formatCheckerIssueReport({
          command: options.report?.command ?? 'limina checker build',
          issues: [issue],
          title: 'Build summary',
          verbose: options.report?.verbose,
        }),
        elapsed(),
      );
    }
    task?.fail('build failed', { error });
    throw error;
  }
}

export async function runCheckerTypecheck(
  options: RunCheckerTypecheckOptions & DeferredCheckIssueOptions,
): Promise<RunCheckerTypecheckResult> {
  if (options.clearScreen ?? true) {
    clearCliScreen();
  }

  const elapsed = createElapsedTimer();
  const task = options.progress
    ? undefined
    : options.flow?.start('checker typecheck', {
        depth: options.flowDepth ?? 0,
      });

  if (!options.report?.defer && !options.flow) {
    TypecheckLogger.info('checker typecheck started');
  }

  try {
    const result = await runCheckerTypecheckImpl(options);

    if (result.passed) {
      await completeCheckSnapshotIfNeeded({
        deferSnapshot: options.deferSnapshot,
        issues: options.issues,
        rootDir: options.config.rootDir,
      });

      if (!options.report?.defer && !options.flow?.interactive) {
        TypecheckLogger.success('checker typecheck finished', elapsed());
      }

      task?.pass();
    } else {
      const issues = createCheckerFailureIssues({
        failedTargets: result.failedTargets,
        fallbackReason: 'Checker typecheck finished with failures.',
        failureKind: result.failureKind,
        fix: 'Inspect the checker typecheck output above, then rerun `limina checker typecheck` or `limina check`.',
        projectRootDir: result.projectRootDir,
        problems: result.problems,
        task: 'checker:typecheck',
        title: 'Checker typecheck failed',
      });

      await collectCheckIssues({
        deferSnapshot: options.deferSnapshot,
        issueSink: options.issues,
        issues,
        rootDir: options.config.rootDir,
      });
      if (!options.report?.defer) {
        TypecheckLogger.error(
          formatCheckerIssueReport({
            command: options.report?.command ?? 'limina checker typecheck',
            issues,
            title: 'Checker typecheck summary',
            verbose: options.report?.verbose,
          }),
          elapsed(),
        );
      }
      task?.fail('checker typecheck finished with failures');
    }

    return result;
  } catch (error) {
    const issue = createTaskFailureIssue({
      code: 'LIMINA_CHECKER_TYPECHECK_FAILED',
      detailLines: [formatErrorMessage(error)],
      fix: 'Inspect the checker typecheck error above, then rerun `limina checker typecheck` or `limina check`.',
      reason: `Checker typecheck failed: ${formatErrorMessage(error)}.`,
      rootDir: options.config.rootDir,
      task: 'checker:typecheck',
      title: 'Checker typecheck failed',
    });

    await collectCheckIssues({
      deferSnapshot: options.deferSnapshot,
      issueSink: options.issues,
      issues: [issue],
      rootDir: options.config.rootDir,
    });
    if (!options.report?.defer) {
      TypecheckLogger.error(
        formatCheckerIssueReport({
          command: options.report?.command ?? 'limina checker typecheck',
          issues: [issue],
          title: 'Checker typecheck summary',
          verbose: options.report?.verbose,
        }),
        elapsed(),
      );
    }
    task?.fail('checker typecheck failed', { error });
    throw error;
  }
}
