import type { ResolvedLiminaConfig } from '#config/runner';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { InputTopologyResult } from '../../core/build-graph/input-topology';
import { resolveInternalProcessEntry } from '../../execution/internal-process-entry';
import { formatErrorMessage } from '../../logger';
import { missingTopologyMembers } from './output-adoption';
import type { RunMigrationOptions } from './types';

export interface MigrationDiskVerification {
  consumable: boolean;
  diagnostics: string[];
  topologies: (Omit<InputTopologyResult, 'workspace'> & { command: string })[];
}

function readChildResult(
  stdout: string,
): MigrationDiskVerification['topologies'] {
  const line = stdout
    .split('\n')
    .findLast((value) => value.startsWith('LIMINA_MIGRATION_INPUT='));
  if (!line)
    throw new Error('Fresh-process verifier did not return an input result.');
  return JSON.parse(
    line.slice('LIMINA_MIGRATION_INPUT='.length),
  ) as MigrationDiskVerification['topologies'];
}

function topologyDiagnostics(
  expected: InputTopologyResult,
  actual: MigrationDiskVerification['topologies'][number],
): string[] {
  const messages = actual.diagnostics.map((diagnostic) => diagnostic.message);
  if (!actual.complete) messages.push('Input analysis is incomplete.');
  if (actual.sources.length === 0)
    messages.push('No governable sources remain.');
  messages.push(
    ...missingTopologyMembers(expected, actual).map(
      (member) => `Planned input membership missing on disk: ${member}`,
    ),
  );
  return messages.map((message) => `${actual.command}: ${message}`);
}

function verificationMode(options: RunMigrationOptions): string {
  return options.mode ?? process.env.NODE_ENV ?? 'default';
}

async function readFromFreshProcess(
  config: ResolvedLiminaConfig,
  options: RunMigrationOptions,
): Promise<MigrationDiskVerification['topologies']> {
  const entry = resolveInternalProcessEntry({
    moduleUrl: import.meta.url,
    sourceFileName: './verify-process.ts',
    bundleFileName: 'migration-verify-process.js',
  });
  if (!entry) throw new Error('Fresh-process input verifier is unavailable.');
  const child = await promisify(execFile)(
    entry.command,
    [
      ...entry.args,
      config.configPath,
      options.configLoader ?? 'native',
      verificationMode(options),
    ],
    { cwd: config.rootDir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  return readChildResult(child.stdout);
}

export async function verifyMigrationFromDisk(
  config: ResolvedLiminaConfig,
  expected: InputTopologyResult,
  options: RunMigrationOptions,
): Promise<MigrationDiskVerification> {
  const result: MigrationDiskVerification = {
    consumable: false,
    diagnostics: [],
    topologies: [],
  };
  try {
    result.topologies = await readFromFreshProcess(config, options);
    result.diagnostics = result.topologies.flatMap((topology) =>
      topologyDiagnostics(expected, topology),
    );
    result.consumable =
      result.topologies.length === 2 && result.diagnostics.length === 0;
  } catch (error) {
    result.diagnostics.push(formatErrorMessage(error));
  }
  return result;
}
