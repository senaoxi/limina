import type { ResolvedLiminaConfig } from '#config/runner';
import { createElapsedTimer } from 'logaria/helper';
import { LiminaStructuredError } from '../check-reporting/errors';
import { clearCliScreen, formatErrorMessage, SourceLogger } from '../logger';
import {
  runSourceCheckImpl,
  type RunSourceCheckOptions,
} from '../source-check/runner';
import {
  appendCheckIssues,
  appendTaskFailureIssueIfMissing,
  completeCheckIssueSnapshot,
  createSourceCheckIssue,
  createTaskFailureIssue,
  writeNotRunSourceIssueSnapshot,
} from '../source-check/snapshot';

export type { RunSourceCheckOptions } from '../source-check/runner';

export async function runSourceCheck(
  config: ResolvedLiminaConfig,
  options: RunSourceCheckOptions = {},
): Promise<boolean> {
  if (!options.deferSnapshot) {
    await writeNotRunSourceIssueSnapshot({
      command: options.report?.command ?? 'limina source check',
      rootDir: config.rootDir,
    });
  }

  if (options.clearScreen ?? true) {
    clearCliScreen();
  }

  const elapsed = createElapsedTimer();
  const task = options.progress
    ? undefined
    : options.flow?.start('source check', {
        depth: options.flowDepth ?? 0,
      });

  if (!options.flow) {
    SourceLogger.info('source check started');
  }

  try {
    const logSuccess = !options.report?.defer && !options.flow?.interactive;
    const sourceIssues = options.sourceIssues ?? [];
    const passed = await runSourceCheckImpl(config, {
      providers: options.providers,
      deferSnapshot: options.deferSnapshot,
      generatedGraphProvider: options.generatedGraphProvider,
      knipRunner: options.knipRunner,
      logSuccess,
      onStats: options.onStats,
      preflight: options.preflight,
      progress: options.progress,
      report: options.report,
      sourceIssues,
    });

    if (passed) {
      if (!options.deferSnapshot) {
        await completeCheckIssueSnapshot({
          rootDir: config.rootDir,
        });
      }

      if (logSuccess) {
        SourceLogger.success('source check finished', elapsed());
      }

      task?.pass();
    } else {
      const issues =
        sourceIssues.length > 0
          ? sourceIssues.map((issue) =>
              createSourceCheckIssue({
                issue,
                rootDir: config.rootDir,
              }),
            )
          : [
              createTaskFailureIssue({
                code: 'LIMINA_SOURCE_CHECK_FAILED',
                filePath: config.configPath,
                fix: 'Inspect the source check report above, then rerun `limina source check` or `limina check`.',
                reason:
                  'Source check finished without structured issue details.',
                rootDir: config.rootDir,
                task: 'source:check',
                title: 'Source check failed',
              }),
            ];

      if (options.deferSnapshot) {
        options.issues?.push(...issues);
      } else {
        await appendTaskFailureIssueIfMissing({
          issue: createTaskFailureIssue({
            code: 'LIMINA_SOURCE_CHECK_FAILED',
            filePath: config.configPath,
            fix: 'Inspect the source check report above, then rerun `limina source check` or `limina check`.',
            reason: 'Source check finished without structured issue details.',
            rootDir: config.rootDir,
            task: 'source:check',
            title: 'Source check failed',
          }),
          rootDir: config.rootDir,
        });
      }
      if (!options.report?.defer && !options.flow) {
        SourceLogger.error('source check failed', elapsed());
      }

      task?.fail('source check failed');
    }

    return passed;
  } catch (error) {
    const issues =
      error instanceof LiminaStructuredError
        ? error.issues
        : [
            createTaskFailureIssue({
              code: 'LIMINA_SOURCE_CHECK_FAILED',
              filePath: config.configPath,
              fix: 'Inspect the source check error above, then rerun `limina source check` or `limina check`.',
              reason: `Source check failed: ${formatErrorMessage(error)}.`,
              rootDir: config.rootDir,
              task: 'source:check',
              title: 'Source check failed',
            }),
          ];

    if (options.deferSnapshot) {
      options.issues?.push(...issues);
    } else {
      await appendCheckIssues({
        issues,
        rootDir: config.rootDir,
      });
    }
    if (!options.report?.defer && !(error instanceof LiminaStructuredError)) {
      SourceLogger.error(
        `source check failed: ${formatErrorMessage(error)}`,
        elapsed(),
      );
    }
    task?.fail('source check failed');

    if (error instanceof LiminaStructuredError) {
      return false;
    }

    throw error;
  }
}
