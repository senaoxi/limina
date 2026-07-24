import { shouldUseColor } from '#utils/reporting';
import { createElapsedTimer } from 'logaria/helper';
import { LiminaStructuredError } from '../check-reporting/errors';
import { formatCheckIssueHumanReport } from '../check-reporting/human';
import {
  appendCheckIssues,
  completeCheckIssueSnapshot,
  createTaskFailureIssue,
  type LiminaCheckIssue,
} from '../check-reporting/snapshot';
import { clearCliScreen, formatErrorMessage, PackageLogger } from '../logger';
import {
  runPackageCheckImpl,
  type RunPackageCheckOptions,
} from '../package-check/runner';
import { resolvePreflight } from '../preflight';

export type { RunPackageCheckOptions } from '../package-check/runner';

function createPackageCheckErrorIssues(
  error: unknown,
  options: RunPackageCheckOptions,
): readonly LiminaCheckIssue[] {
  if (error instanceof LiminaStructuredError) return error.issues;
  return [
    createTaskFailureIssue({
      code: 'LIMINA_PACKAGE_CHECK_FAILED',
      detailLines: [formatErrorMessage(error)],
      filePath: options.config.configPath,
      fix: 'Inspect the package check error above, then rerun `limina package check` or the package pipeline.',
      packageName:
        options.packageNames?.length === 1
          ? options.packageNames[0]
          : undefined,
      reason: `Package check failed: ${formatErrorMessage(error)}.`,
      rootDir: options.config.rootDir,
      task: 'package:check',
      title: 'Package check failed',
      tool: options.tool ?? 'all',
    }),
  ];
}

export async function runPackageCheck(
  options: RunPackageCheckOptions,
): Promise<boolean> {
  const preflight = resolvePreflight(options.config, options);
  if (options.clearScreen ?? true) {
    clearCliScreen();
  }

  const elapsed = createElapsedTimer();
  const task = options.progress
    ? undefined
    : options.flow?.start('package check', {
        depth: options.flowDepth ?? 0,
      });

  try {
    if (!options.report?.defer) {
      PackageLogger.info('package check started');
    }

    const issues: LiminaCheckIssue[] = [];
    const passed = await runPackageCheckImpl({
      ...options,
      issues,
      preflight,
    });

    if (passed) {
      if (!options.deferSnapshot) {
        await completeCheckIssueSnapshot({
          artifactNamespace: preflight.artifactNamespace,
          rootDir: options.config.rootDir,
        });
      }

      if (!options.report?.defer && !options.flow?.interactive) {
        PackageLogger.success('package check finished', elapsed());
      }

      task?.pass();
    } else {
      const reportIssues =
        issues.length > 0
          ? issues
          : [
              createTaskFailureIssue({
                code: 'LIMINA_PACKAGE_CHECK_FAILED',
                filePath: options.config.configPath,
                fix: 'Inspect the package check report above, then rerun `limina package check` or the package pipeline.',
                packageName:
                  options.packageNames?.length === 1
                    ? options.packageNames[0]
                    : undefined,
                reason:
                  'Package check found package manifest, publint, ATTW, or published boundary failures.',
                rootDir: options.config.rootDir,
                task: 'package:check',
                title: 'Package check failed',
                tool: options.tool ?? 'all',
              }),
            ];

      if (options.deferSnapshot) {
        options.issues?.push(...reportIssues);
      } else {
        await appendCheckIssues({
          artifactNamespace: preflight.artifactNamespace,
          issues: reportIssues,
          rootDir: options.config.rootDir,
        });
      }
      if (!options.report?.defer) {
        PackageLogger.error(
          formatCheckIssueHumanReport({
            color: shouldUseColor(),
            command: options.report?.command ?? 'limina package check',
            issues: reportIssues,
            title: 'Package check summary',
            verbose: options.report?.verbose,
          }),
          elapsed(),
        );
      }
      task?.fail('package check finished with failures');
    }

    return passed;
  } catch (error) {
    const issues = createPackageCheckErrorIssues(error, options);

    if (options.deferSnapshot) {
      options.issues?.push(...issues);
    } else {
      await appendCheckIssues({
        artifactNamespace: preflight.artifactNamespace,
        issues,
        rootDir: options.config.rootDir,
      });
    }
    if (!options.report?.defer) {
      PackageLogger.error(
        formatCheckIssueHumanReport({
          color: shouldUseColor(),
          command: options.report?.command ?? 'limina package check',
          issues,
          title: 'Package check summary',
          verbose: options.report?.verbose,
        }),
        elapsed(),
      );
    }
    task?.fail(
      'package check failed',
      error instanceof LiminaStructuredError ? undefined : { error },
    );
    throw error;
  }
}
