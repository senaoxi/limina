import type {
  PackageAttwCheckConfig,
  PackageEntry,
  PackagePublintCheckConfig,
  ResolvedLiminaConfig,
} from '#config/runner';
import { toRelativePath } from '#utils/path';
import { isPlainRecord } from '#utils/values';
import { PackageLogger } from '../logger';
import type { PackageEntrySelectionPlan } from './entry/selection';

export function getPackagePublintCheckConfig(
  entry: PackageEntry,
): PackagePublintCheckConfig {
  return isPlainRecord(entry.publint) ? entry.publint : {};
}

export function getPackageAttwCheckConfig(
  entry: PackageEntry,
): PackageAttwCheckConfig {
  return isPlainRecord(entry.attw) ? entry.attw : {};
}

function formatEntryPlan(
  config: ResolvedLiminaConfig,
  entry: PackageEntrySelectionPlan['entries'][number],
): string {
  const checks = entry.checks.length === 0 ? '(none)' : entry.checks.join(', ');
  return [
    `    - ${entry.label}`,
    `      outDir: ${toRelativePath(config.rootDir, entry.outDir)}`,
    `      checks: ${checks}`,
  ].join('\n');
}

export function logPackageCheckPlan(options: {
  config: ResolvedLiminaConfig;
  cwd: string;
  plan: PackageEntrySelectionPlan;
}): void {
  PackageLogger.info(
    [
      'Package check plan:',
      `  config: ${toRelativePath(
        options.config.rootDir,
        options.config.configPath,
      )}`,
      `  cwd: ${toRelativePath(options.config.rootDir, options.cwd)}`,
      `  selection: ${options.plan.selectionReason}`,
      '  entries:',
      ...options.plan.entries.map((entry) =>
        formatEntryPlan(options.config, entry),
      ),
    ].join('\n'),
  );
}
