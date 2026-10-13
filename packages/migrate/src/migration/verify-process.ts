import {
  createDefaultInputs,
  findLiminaConfigPath,
  loadConfig,
  type ResolvedLiminaInputs,
} from 'limina/internal/config/runner';
import { readInputTopology } from 'limina/internal/core/build-graph/input-topology';
import {
  classifyGovernanceRoot,
  readGovernanceManifest,
  type ResolvedGovernanceRoot,
} from 'limina/internal/utils/workspace-root';
import { assertRuntimeVersion } from '../runtime-version';
import {
  discoverMigrationScope,
  governanceBinding,
  type MigrationConfigSource,
} from './scope';
import type { MigrationVerificationLocator } from './verification';

function loaderName(value: string | undefined): 'native' | 'tsx' {
  if (value === 'native') return value;
  if (value === 'tsx') return value;
  throw new Error('Invalid migration verification loader.');
}
function commandName(value: string | undefined): 'check' | 'graph' {
  if (value === 'check') return value;
  if (value === 'graph') return value;
  throw new Error('Invalid migration verification command.');
}
function isSameRoot(
  root: ResolvedGovernanceRoot,
  locator: MigrationVerificationLocator,
): boolean {
  return [
    root.rootDir === locator.rootDir,
    root.manifestPath === locator.manifestPath,
    root.kind === locator.rootKind,
    governanceBinding(root) === locator.rootBinding,
  ].every(Boolean);
}
function lockedRoot(
  locator: MigrationVerificationLocator,
): ResolvedGovernanceRoot {
  const root = classifyGovernanceRoot(
    readGovernanceManifest(locator.manifestPath),
  );
  if (!isSameRoot(root, locator))
    throw new Error('Migration verification root binding changed on disk.');
  return root;
}
function defaultInputs(
  locator: MigrationVerificationLocator,
): ResolvedLiminaInputs {
  const discovered = discoverMigrationScope({ cwd: locator.cwd });
  if (discovered.source.kind !== 'defaults')
    throw new Error('Default migration verification source changed on disk.');
  if (discovered.root.manifestPath !== locator.manifestPath)
    throw new Error('Default migration verification root changed on disk.');
  return createDefaultInputs(lockedRoot(locator));
}
function assertConfigSelection(locator: {
  cwd: string;
  source: Extract<MigrationConfigSource, { kind: 'file' }>;
}): void {
  if (locator.source.discovery !== 'ancestor') return;
  if (findLiminaConfigPath(locator.cwd) !== locator.source.configPath)
    throw new Error(
      'Migration verification configuration selection changed on disk.',
    );
}
async function fileInputs(input: {
  locator: MigrationVerificationLocator;
  command: 'check' | 'graph';
  configLoader: 'native' | 'tsx';
  mode: string | undefined;
}): Promise<ResolvedLiminaInputs> {
  const { locator } = input;
  if (locator.source.kind !== 'file')
    throw new Error('Expected a real migration verification config.');
  assertConfigSelection({ cwd: locator.cwd, source: locator.source });
  const config = await loadConfig({
    command: input.command,
    configPath: locator.source.configPath,
    configLoader: input.configLoader,
    mode: input.mode,
  });
  if (!isSameRoot(config.governanceRoot, locator))
    throw new Error(
      'Migration verification configuration changed the governance root.',
    );
  return config;
}
async function readVerificationInputs(
  input: Parameters<typeof fileInputs>[0],
): Promise<ResolvedLiminaInputs> {
  lockedRoot(input.locator);
  return input.locator.source.kind === 'defaults'
    ? defaultInputs(input.locator)
    : fileInputs(input);
}
async function main(): Promise<void> {
  assertRuntimeVersion();
  const [location, loader, mode, requestedCommand] = process.argv.slice(2);
  if (!location)
    throw new Error('Missing migration verification input location.');
  const locator = JSON.parse(location) as MigrationVerificationLocator;
  const command = commandName(requestedCommand);
  const config = await readVerificationInputs({
    locator,
    command,
    configLoader: loaderName(loader),
    mode,
  });
  const topology = await readInputTopology(config);
  delete topology.workspace;
  process.stdout.write(
    `\nLIMINA_MIGRATION_INPUT=${JSON.stringify([{ command, ...topology }])}\n`,
  );
}
try {
  await main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
}
