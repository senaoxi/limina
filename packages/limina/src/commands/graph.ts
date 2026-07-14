import type { ResolvedLiminaConfig } from '#config/runner';
import { createElapsedTimer } from 'logaria/helper';
import { LiminaStructuredError } from '../check-reporting/errors';
import { formatCheckIssueHumanReport } from '../check-reporting/human';
import {
  appendCheckIssues,
  completeCheckIssueSnapshot,
  createTaskFailureIssue,
  type LiminaCheckIssue,
} from '../check-reporting/snapshot';
import type { DependencyGraphDocument } from '../dependency-graph/runner';
import {
  runGraphCheckImpl,
  type RunGraphCheckOptions,
  runGraphExportImpl,
  type RunGraphExportOptions,
  runGraphPrepareImpl,
  type RunGraphPrepareOptions,
} from '../graph-check/runner';
import { clearCliScreen, formatErrorMessage, GraphLogger } from '../logger';

export type {
  RunGraphCheckOptions,
  RunGraphExportOptions,
  RunGraphPrepareOptions,
} from '../graph-check/runner';

function createGraphCheckErrorIssue(
  config: ResolvedLiminaConfig,
  errorMessage: string,
): LiminaCheckIssue {
  return createTaskFailureIssue({
    code: 'LIMINA_GRAPH_CHECK_FAILED',
    detailLines: errorMessage.split('\n'),
    filePath: config.configPath,
    fix: 'Inspect the graph check error above, then rerun `limina graph check` or `limina check`.',
    reason: `Graph check failed: ${errorMessage}.`,
    rootDir: config.rootDir,
    task: 'graph:check',
    title: 'Graph check failed',
  });
}

export async function runGraphPrepare(
  config: ResolvedLiminaConfig,
  options: RunGraphPrepareOptions = {},
): Promise<boolean> {
  if (options.clearScreen ?? true) {
    clearCliScreen();
  }

  const elapsed = createElapsedTimer();
  const task = options.progress
    ? undefined
    : options.flow?.start('graph prepare', {
        depth: options.flowDepth ?? 0,
      });

  GraphLogger.info('graph prepare started');

  try {
    const result = await runGraphPrepareImpl(config, options);

    if (!options.flow?.interactive) {
      GraphLogger.success(
        result.changed
          ? 'graph prepare generated files'
          : 'graph prepare found generated files up to date',
        elapsed(),
      );
    }

    task?.pass();
    if (!options.deferSnapshot) {
      await completeCheckIssueSnapshot({
        rootDir: config.rootDir,
      });
    }
    return true;
  } catch (error) {
    const issues =
      error instanceof LiminaStructuredError
        ? error.issues
        : [
            createTaskFailureIssue({
              code: 'LIMINA_GRAPH_PREPARE_FAILED',
              filePath: config.configPath,
              fix: 'Inspect the graph prepare error above, then rerun `limina graph prepare` or `limina check`.',
              reason: `Graph prepare failed: ${formatErrorMessage(error)}.`,
              rootDir: config.rootDir,
              task: 'graph:prepare',
              title: 'Graph prepare failed',
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

    if (!options.report?.defer && error instanceof LiminaStructuredError) {
      GraphLogger.error(
        formatCheckIssueHumanReport({
          command: options.report?.command ?? 'limina graph prepare',
          issues,
          title: 'Graph prepare summary',
          verbose: options.report?.verbose,
        }),
      );
    }

    const errorMessage = formatErrorMessage(error);
    const showRawStructuredError =
      !(error instanceof LiminaStructuredError) || options.report?.verbose;

    GraphLogger.error(
      showRawStructuredError
        ? `graph prepare failed: ${errorMessage}`
        : 'graph prepare failed',
      elapsed(),
    );
    if (showRawStructuredError) {
      task?.fail('graph prepare failed', { error });
    } else {
      task?.fail('graph prepare failed');
    }
    throw error;
  }
}

export async function runGraphCheck(
  config: ResolvedLiminaConfig,
  options: RunGraphCheckOptions = {},
): Promise<boolean> {
  if (options.clearScreen ?? true) {
    clearCliScreen();
  }

  const elapsed = createElapsedTimer();
  const task = options.progress
    ? undefined
    : options.flow?.start('graph check', {
        depth: options.flowDepth ?? 0,
      });

  if (!options.flow) {
    GraphLogger.info('graph check started');
  }

  try {
    const logSuccess = !options.report?.defer && !options.flow?.interactive;
    const issues: LiminaCheckIssue[] = [];
    const passed = await runGraphCheckImpl(config, {
      providers: options.providers,
      generatedGraphProvider: options.generatedGraphProvider,
      issues,
      logSuccess,
      onStats: options.onStats,
      preflight: options.preflight,
      progress: options.progress,
      report: options.report,
    });

    if (passed) {
      if (!options.deferSnapshot) {
        await completeCheckIssueSnapshot({
          rootDir: config.rootDir,
        });
      }

      if (logSuccess) {
        GraphLogger.success('graph check finished', elapsed());
      }

      task?.pass();
    } else {
      const reportIssues =
        issues.length > 0
          ? issues
          : [
              createTaskFailureIssue({
                code: 'LIMINA_GRAPH_CHECK_FAILED',
                filePath: config.configPath,
                fix: 'Inspect the graph check report above, update the source/config/package boundary, then rerun `limina graph check` or `limina check`.',
                reason:
                  'Graph check found architecture, dependency, or resolver violations.',
                rootDir: config.rootDir,
                task: 'graph:check',
                title: 'Graph check failed',
              }),
            ];

      if (options.deferSnapshot) {
        options.issues?.push(...reportIssues);
      } else {
        await appendCheckIssues({
          issues: reportIssues,
          rootDir: config.rootDir,
        });
      }
      if (!options.flow) {
        GraphLogger.error('graph check finished with failures', elapsed());
      }
      task?.fail('graph check finished with failures');
    }

    return passed;
  } catch (error) {
    const errorMessage = formatErrorMessage(error);
    const issues =
      error instanceof LiminaStructuredError
        ? error.issues
        : [createGraphCheckErrorIssue(config, errorMessage)];

    if (options.deferSnapshot) {
      options.issues?.push(...issues);
    } else {
      await appendCheckIssues({
        issues,
        rootDir: config.rootDir,
      });
    }

    if (!options.report?.defer) {
      GraphLogger.error(
        formatCheckIssueHumanReport({
          command: options.report?.command ?? 'limina graph check',
          issues,
          title: 'Graph check summary',
          verbose: options.report?.verbose,
        }),
      );
    }
    task?.fail('graph check failed');

    if (options.flow) {
      return false;
    }

    throw error;
  }
}

export async function runGraphExport(
  config: ResolvedLiminaConfig,
  options: RunGraphExportOptions = {},
): Promise<DependencyGraphDocument> {
  return await runGraphExportImpl(config, options);
}
