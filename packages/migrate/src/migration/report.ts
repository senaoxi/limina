import { writeJsonAtomically } from 'limina/internal/check-reporting/atomic-writer';
import {
  configContextPath,
  type ResolvedLiminaInputs,
} from 'limina/internal/config/runner';
import type { LiminaArtifactNamespace } from 'limina/internal/domain/artifacts/namespace';
import { formatErrorMessage, MigrationLogger } from 'limina/internal/logger';
import { stripVTControlCharacters } from 'node:util';
import path from 'pathe';
import type { MigrationRecord } from './declarations';
import type { FrozenMigrationPlan } from './planner';
import { MigrationPlanningError } from './progress';
import { migrationInputSource } from './scope';
import type { RunMigrationOptions, RunMigrationResult } from './types';
import type { MigrationDiskVerification } from './verification';

export async function publishReport(options: {
  config: ResolvedLiminaInputs;
  namespace: LiminaArtifactNamespace;
  plan: FrozenMigrationPlan;
  verification: MigrationDiskVerification;
  result: RunMigrationResult;
  runOptions: RunMigrationOptions;
}): Promise<void> {
  const reportPath = path.join(
    options.config.rootDir,
    '.limina/migration/latest.json',
  );
  try {
    await writeJsonAtomically(options.namespace, reportPath, {
      version: 1,
      result: options.result,
      records: options.plan.records,
      verification: options.verification,
    });
    options.result.reportPath = reportPath;
  } catch (error) {
    options.result.reportWarning = `Migration report publication failed: ${formatErrorMessage(error)}`;
    MigrationLogger.warn(options.result.reportWarning);
    options.runOptions.flow?.warn(options.result.reportWarning);
  }
}

export async function publishFailure(options: {
  config: ResolvedLiminaInputs;
  namespace: LiminaArtifactNamespace;
  plan?: FrozenMigrationPlan;
  error: unknown;
  runOptions: RunMigrationOptions;
}): Promise<void> {
  const message = stripVTControlCharacters(formatErrorMessage(options.error));
  const records = failureRecords(options);
  const reportPath = path.join(
    options.config.rootDir,
    '.limina/migration/latest.json',
  );
  try {
    await writeJsonAtomically(options.namespace, reportPath, {
      version: 1,
      result: {
        processingComplete: false,
        inputConsumable: false,
        outcome: 'applied',
        inputSource: failureSource(options.config, options.runOptions),
        incompleteFiles: [configContextPath(options.config)],
      },
      records: [
        ...records,
        {
          configPath: configContextPath(options.config),
          kind: 'migration-failed',
          message,
        },
      ],
      verification: {
        consumable: false,
        diagnostics: [
          'Migration stopped before disk consumption could be confirmed.',
        ],
        topologies: [],
      },
    });
    MigrationLogger.info(`migration audit: ${reportPath}`);
  } catch (error) {
    warnFailureReport(options.runOptions, error);
  }
}

export function failureRecords(options: {
  plan?: FrozenMigrationPlan;
  error: unknown;
}): MigrationRecord[] {
  if (options.plan) return options.plan.records;
  return options.error instanceof MigrationPlanningError
    ? options.error.records
    : [];
}

function failureSource(
  config: ResolvedLiminaInputs,
  options: RunMigrationOptions,
) {
  return options.scope?.source ?? migrationInputSource(config);
}

function warnFailureReport(options: RunMigrationOptions, error: unknown): void {
  const warning = `Migration failure report publication failed: ${formatErrorMessage(error)}`;
  MigrationLogger.warn(warning);
  options.flow?.warn(warning);
}
