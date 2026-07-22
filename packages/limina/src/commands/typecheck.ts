import { createElapsedTimer } from 'logaria/helper';
import path from 'pathe';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import { LiminaStructuredError } from '../check-reporting/errors';
import { formatCheckIssueHumanReport } from '../check-reporting/human';
import {
  appendCheckIssues,
  completeCheckIssueSnapshot,
  createTaskFailureIssue,
  type LiminaCheckIssue,
  type LiminaCheckTaskName,
} from '../check-reporting/snapshot';
import type { LiminaArtifactNamespace } from '../domain/artifacts/namespace';
import { clearCliScreen, formatErrorMessage, TypecheckLogger } from '../logger';
import { resolvePreflight } from '../preflight';
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
  CheckerTargetId,
  CheckerTargetOutcome,
  TypecheckRunner,
  TypecheckTarget,
  TypecheckTargetResult,
} from '../typecheck/targets';

interface DeferredCheckIssueOptions {
  deferSnapshot?: boolean;
  issues?: LiminaCheckIssue[];
}

async function collectCheckIssues(options: {
  artifactNamespace: LiminaArtifactNamespace;
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
    artifactNamespace: options.artifactNamespace,
    issues: options.issues,
    rootDir: options.rootDir,
  });
}

async function completeCheckSnapshotIfNeeded(
  options: DeferredCheckIssueOptions & {
    artifactNamespace: LiminaArtifactNamespace;
    rootDir: string;
  },
): Promise<void> {
  if (options.deferSnapshot) {
    return;
  }

  await completeCheckIssueSnapshot({
    artifactNamespace: options.artifactNamespace,
    rootDir: options.rootDir,
  });
}

function getCheckerFailureFilePath(options: {
  config: { configPath: string };
  configPath?: string;
  cwd?: string;
}): string {
  return options.configPath
    ? path.resolve(options.cwd ?? process.cwd(), options.configPath)
    : options.config.configPath;
}

function createCheckerFailureIssues(options: {
  failedTargets: readonly CheckerFailureTarget[];
  fallbackFilePath?: string;
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
    options.failureKind === 'peer-dependency' &&
    options.task === 'checker:build'
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
        filePath: options.fallbackFilePath,
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
  const preflight = resolvePreflight(options.config, options);
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
    const result = await runCheckerBuildImpl({ ...options, preflight });

    if (result.passed) {
      await completeCheckSnapshotIfNeeded({
        artifactNamespace: preflight.artifactNamespace,
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
        fallbackFilePath: getCheckerFailureFilePath(options),
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
        artifactNamespace: preflight.artifactNamespace,
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
    const issues =
      error instanceof LiminaStructuredError
        ? error.issues
        : [
            createTaskFailureIssue({
              code: 'LIMINA_CHECKER_BUILD_FAILED',
              ...(options.report?.defer
                ? {}
                : { detailLines: [formatErrorMessage(error)] }),
              fix: 'Inspect the checker build error above, then rerun `limina checker build` or `limina check`.',
              filePath: getCheckerFailureFilePath(options),
              reason: options.report?.defer
                ? 'Checker build failed.'
                : `Checker build failed: ${formatErrorMessage(error)}.`,
              rootDir: options.config.rootDir,
              ...(options.report?.defer
                ? { summary: 'Checker build failed' }
                : {}),
              task: 'checker:build',
              title: 'Checker build failed',
            }),
          ];

    await collectCheckIssues({
      artifactNamespace: preflight.artifactNamespace,
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
    task?.fail(
      'checker build failed',
      error instanceof LiminaStructuredError ? undefined : { error },
    );

    if (error instanceof LiminaStructuredError) {
      throw error;
    }

    throw error;
  }
}

export async function runBuild(
  options: RunBuildOptions & DeferredCheckIssueOptions,
): Promise<RunBuildResult> {
  const preflight = resolvePreflight(options.config, options);
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
    const result = await runBuildImpl({ ...options, preflight });

    if (result.passed) {
      await completeCheckSnapshotIfNeeded({
        artifactNamespace: preflight.artifactNamespace,
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
        fallbackFilePath: getCheckerFailureFilePath(options),
        fallbackReason: 'Checker build finished with failures.',
        failureKind: result.failureKind,
        fix: 'Inspect the build output above, then rerun `limina build <config>`.',
        projectRootDir: result.projectRootDir,
        problems: result.problems,
        task: 'checker:build',
        title: 'Checker build failed',
      });

      await collectCheckIssues({
        artifactNamespace: preflight.artifactNamespace,
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
    const issues =
      error instanceof LiminaStructuredError
        ? error.issues
        : [
            createTaskFailureIssue({
              code: 'LIMINA_CHECKER_BUILD_FAILED',
              detailLines: [formatErrorMessage(error)],
              filePath: getCheckerFailureFilePath(options),
              fix: 'Inspect the build error above, then rerun `limina build <config>`.',
              reason: `Checker build failed: ${formatErrorMessage(error)}.`,
              rootDir: options.config.rootDir,
              task: 'checker:build',
              title: 'Checker build failed',
            }),
          ];

    await collectCheckIssues({
      artifactNamespace: preflight.artifactNamespace,
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
    task?.fail(
      'build failed',
      error instanceof LiminaStructuredError ? undefined : { error },
    );
    throw error;
  }
}

export async function runCheckerTypecheck(
  options: RunCheckerTypecheckOptions & DeferredCheckIssueOptions,
): Promise<RunCheckerTypecheckResult> {
  const preflight = resolvePreflight(options.config, options);
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
    const result = await runCheckerTypecheckImpl({ ...options, preflight });

    if (result.passed) {
      await completeCheckSnapshotIfNeeded({
        artifactNamespace: preflight.artifactNamespace,
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
        fallbackFilePath: options.config.configPath,
        fallbackReason: 'Checker typecheck finished with failures.',
        failureKind: result.failureKind,
        fix: 'Inspect the checker typecheck output above, then rerun `limina checker typecheck` or `limina check`.',
        projectRootDir: result.projectRootDir,
        problems: result.problems,
        task: 'checker:typecheck',
        title: 'Checker typecheck failed',
      });

      await collectCheckIssues({
        artifactNamespace: preflight.artifactNamespace,
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
    const issues =
      error instanceof LiminaStructuredError
        ? error.issues
        : [
            createTaskFailureIssue({
              code: 'LIMINA_CHECKER_TYPECHECK_FAILED',
              detailLines: [formatErrorMessage(error)],
              filePath: options.config.configPath,
              fix: 'Inspect the checker typecheck error above, then rerun `limina checker typecheck` or `limina check`.',
              reason: `Checker typecheck failed: ${formatErrorMessage(error)}.`,
              rootDir: options.config.rootDir,
              task: 'checker:typecheck',
              title: 'Checker typecheck failed',
            }),
          ];

    await collectCheckIssues({
      artifactNamespace: preflight.artifactNamespace,
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
    task?.fail(
      'checker typecheck failed',
      error instanceof LiminaStructuredError ? undefined : { error },
    );
    throw error;
  }
}
