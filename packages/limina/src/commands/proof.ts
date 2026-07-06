import type { ResolvedLiminaConfig } from '#config/runner';
import { createElapsedTimer } from 'logaria/helper';
import { LiminaStructuredError } from '../check-reporting/errors';
import { formatCheckIssueHumanReport } from '../check-reporting/human';
import {
  appendCheckIssues,
  appendTaskFailureIssueIfMissing,
  completeCheckIssueSnapshot,
  createTaskFailureIssue,
} from '../check-reporting/snapshot';
import { clearCliScreen, formatErrorMessage, ProofLogger } from '../logger';
import { runProofCheckImpl, type RunProofCheckOptions } from '../proof/runner';

export type { RunProofCheckOptions } from '../proof/runner';

export async function runProofCheck(
  config: ResolvedLiminaConfig,
  options: RunProofCheckOptions = {},
): Promise<boolean> {
  if (options.clearScreen ?? true) {
    clearCliScreen();
  }

  const elapsed = createElapsedTimer();
  const task = options.progress
    ? undefined
    : options.flow?.start('proof check', {
        depth: options.flowDepth ?? 0,
      });

  if (!options.flow) {
    ProofLogger.info('proof check started');
  }

  try {
    const logSuccess = !options.report?.defer && !options.flow?.interactive;
    const issues = options.issues ?? [];
    const passed = await runProofCheckImpl(config, {
      core: options.core,
      deferSnapshot: options.deferSnapshot,
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
        ProofLogger.success('proof check finished', elapsed());
      }

      task?.pass();
    } else {
      if (options.deferSnapshot) {
        if (issues.length === 0) {
          options.issues?.push(
            createTaskFailureIssue({
              code: 'LIMINA_PROOF_CHECK_FAILED',
              filePath: config.configPath,
              fix: 'Inspect the proof check report above, then adjust checker coverage, config.source, or proof.allowlist.',
              reason:
                'Proof check found source coverage or checker graph proof violations.',
              rootDir: config.rootDir,
              task: 'proof:check',
              title: 'Proof check failed',
            }),
          );
        }
      } else {
        await appendTaskFailureIssueIfMissing({
          issue: createTaskFailureIssue({
            code: 'LIMINA_PROOF_CHECK_FAILED',
            filePath: config.configPath,
            fix: 'Inspect the proof check report above, then adjust checker coverage, config.source, or proof.allowlist.',
            reason:
              'Proof check found source coverage or checker graph proof violations.',
            rootDir: config.rootDir,
            task: 'proof:check',
            title: 'Proof check failed',
          }),
          rootDir: config.rootDir,
        });
      }
      if (!options.report?.defer && !options.flow) {
        ProofLogger.error('proof check finished with failures', elapsed());
      }
      task?.fail('proof check finished with failures');
    }

    return passed;
  } catch (error) {
    const issues =
      error instanceof LiminaStructuredError
        ? error.issues
        : [
            createTaskFailureIssue({
              code: 'LIMINA_PROOF_CHECK_FAILED',
              detailLines: [formatErrorMessage(error)],
              filePath: config.configPath,
              fix: 'Inspect the proof check error above, then rerun `limina proof check` or `limina check`.',
              reason: `Proof check failed: ${formatErrorMessage(error)}.`,
              rootDir: config.rootDir,
              task: 'proof:check',
              title: 'Proof check failed',
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
      ProofLogger.error(
        formatCheckIssueHumanReport({
          command: options.report?.command ?? 'limina proof check',
          issues,
          title: 'Proof check summary',
          verbose: options.report?.verbose,
        }),
        elapsed(),
      );
    }
    task?.fail(
      'proof check failed',
      error instanceof LiminaStructuredError ? undefined : { error },
    );

    if (error instanceof LiminaStructuredError) {
      throw error;
    }

    throw error;
  }
}
