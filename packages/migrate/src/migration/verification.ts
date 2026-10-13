import type { ResolvedLiminaInputs } from 'limina/internal/config/runner';
import type { InputTopologyResult } from 'limina/internal/core/build-graph/input-topology';
import { formatErrorMessage } from 'limina/internal/logger';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { missingTopologyMembers } from './output-adoption';
import { resolveMigrationProcessEntry } from './process-entry';
import {
  governanceBinding,
  type MigrationConfigSource,
  migrationInputSource,
} from './scope';
import type { RunMigrationOptions } from './types';

export interface MigrationVerificationLocator {
  source: MigrationConfigSource;
  rootDir: string;
  cwd: string;
  manifestPath: string;
  rootKind: ResolvedLiminaInputs['governanceRoot']['kind'];
  rootBinding: string;
}
interface VerificationOptions extends RunMigrationOptions {
  verificationSource?: MigrationConfigSource;
  rootBinding?: string;
}
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
async function readFromFreshProcess(input: {
  config: ResolvedLiminaInputs;
  options: VerificationOptions;
  command: 'check' | 'graph';
  locator: MigrationVerificationLocator;
}): Promise<MigrationDiskVerification['topologies']> {
  const entry = resolveMigrationProcessEntry({
    moduleUrl: import.meta.url,
    sourceFileName: './verify-process.ts',
    bundleFileName: 'migration-verify-process.js',
  });
  if (!entry) throw new Error('Fresh-process input verifier is unavailable.');
  const child = await promisify(execFile)(
    entry.command,
    [
      ...entry.args,
      JSON.stringify(input.locator),
      input.options.configLoader ?? 'native',
      verificationMode(input.options),
      input.command,
    ],
    {
      cwd: input.config.rootDir,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return readChildResult(child.stdout);
}
function verificationCwd(
  config: ResolvedLiminaInputs,
  options: VerificationOptions,
): string {
  return options.scope?.cwd ?? config.rootDir;
}
function locatorSource(
  config: ResolvedLiminaInputs,
  options: VerificationOptions,
): MigrationConfigSource {
  return options.verificationSource ?? migrationInputSource(config);
}
function locatorBinding(
  config: ResolvedLiminaInputs,
  options: VerificationOptions,
): string {
  return options.rootBinding ?? governanceBinding(config.governanceRoot);
}
function verificationLocator(
  config: ResolvedLiminaInputs,
  options: VerificationOptions,
): MigrationVerificationLocator {
  return {
    source: locatorSource(config, options),
    rootDir: config.rootDir,
    cwd: verificationCwd(config, options),
    manifestPath: config.governanceRoot.manifestPath,
    rootKind: config.governanceRoot.kind,
    rootBinding: locatorBinding(config, options),
  };
}
export async function verifyMigrationFromDisk(
  config: ResolvedLiminaInputs,
  expected: InputTopologyResult,
  options: VerificationOptions,
): Promise<MigrationDiskVerification> {
  const result: MigrationDiskVerification = {
    consumable: false,
    diagnostics: [],
    topologies: [],
  };
  try {
    const locator = verificationLocator(config, options);
    result.topologies = [
      ...(await readFromFreshProcess({
        config,
        options,
        command: 'check',
        locator,
      })),
      ...(await readFromFreshProcess({
        config,
        options,
        command: 'graph',
        locator,
      })),
    ];
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
