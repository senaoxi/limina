import {
  createDefaultInputs,
  findLiminaConfigPath,
  loadConfig,
  type LoadConfigOptions,
  type ResolvedLiminaInputs,
  resolveExecutionConfigLocation,
} from 'limina/internal/config/runner';
import type { LiminaFlowReporter } from 'limina/internal/flow';
import { normalizeAbsolutePath } from 'limina/internal/utils/path';
import {
  classifyGovernanceRoot,
  type ResolvedGovernanceRoot,
  resolveGovernanceManifest,
  resolveGovernanceRoot,
} from 'limina/internal/utils/workspace-root';
import { createHash } from 'node:crypto';
import {
  type BigIntStats,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'pathe';
import { isConfirmMigrationScope } from './prompts';

export type MigrationConfigSource =
  | { kind: 'file'; configPath: string; discovery: 'explicit' | 'ancestor' }
  | { kind: 'defaults' };
export interface MigrationScope {
  cwd: string;
  root: ResolvedGovernanceRoot;
  source: MigrationConfigSource;
  binding: string;
}
interface ScopeDiscoveryOptions {
  cwd: string;
  configPath?: string;
}

function locationContents(
  file: string,
  physical: BigIntStats,
  isRead: boolean,
): string | undefined {
  if (!isRead) return undefined;
  if (!physical.isFile()) throw new Error(`Expected a regular file: ${file}`);
  return readFileSync(file).toString('base64');
}
function readLocationIdentity(file: string, isReadContents: boolean): unknown {
  const lexical = lstatSync(file, { bigint: true });
  const physical = statSync(file, { bigint: true });
  return [
    normalizeAbsolutePath(realpathSync.native(file)),
    String(lexical.dev),
    String(lexical.ino),
    String(lexical.mode),
    String(physical.dev),
    String(physical.ino),
    String(physical.mode),
    locationContents(file, physical, isReadContents),
  ];
}
function locationIdentity(file: string, isReadContents: boolean): unknown {
  try {
    return readLocationIdentity(file, isReadContents);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function governanceBinding(root: ResolvedGovernanceRoot): string {
  return digest([
    root.rootDir,
    root.manifestPath,
    root.kind,
    root.kind === 'workspace' ? root.packageManager : undefined,
    locationIdentity(root.rootDir, false),
    locationIdentity(root.manifestPath, true),
    locationIdentity(path.join(root.rootDir, 'pnpm-workspace.yaml'), true),
  ]);
}
function ancestorSource(cwd: string): MigrationConfigSource {
  const configPath = findLiminaConfigPath(cwd);
  return configPath === null
    ? { kind: 'defaults' }
    : { kind: 'file', configPath, discovery: 'ancestor' };
}
function discoverSource(options: ScopeDiscoveryOptions): MigrationConfigSource {
  if (options.configPath === undefined) return ancestorSource(options.cwd);
  return {
    kind: 'file',
    configPath: resolveExecutionConfigLocation(options).configPath,
    discovery: 'explicit',
  };
}
function sourceRoot(
  source: MigrationConfigSource,
  cwd: string,
): ResolvedGovernanceRoot {
  return source.kind === 'file'
    ? resolveGovernanceRoot(source.configPath)
    : classifyGovernanceRoot(resolveGovernanceManifest(cwd));
}
function sourceIdentity(source: MigrationConfigSource): unknown {
  return source.kind === 'file'
    ? locationIdentity(source.configPath, true)
    : undefined;
}
export function discoverMigrationScope(
  options: ScopeDiscoveryOptions,
): MigrationScope {
  const cwd = normalizeAbsolutePath(options.cwd);
  const source = discoverSource({ ...options, cwd });
  const root = sourceRoot(source, cwd);
  return {
    cwd,
    root,
    source,
    binding: digest([
      source,
      governanceBinding(root),
      locationIdentity(cwd, false),
      sourceIdentity(source),
    ]),
  };
}
function explicitPath(source: MigrationConfigSource): string | undefined {
  if (source.kind === 'defaults') return undefined;
  return source.discovery === 'explicit' ? source.configPath : undefined;
}
export function assertMigrationScopeUnchanged(scope: MigrationScope): void {
  const current = discoverMigrationScope({
    cwd: scope.cwd,
    configPath: explicitPath(scope.source),
  });
  if (current.binding !== scope.binding)
    throw new Error(
      'Migration scope changed after discovery. Rerun migration to confirm the new root and configuration.',
    );
}
export function migrationInputSource(
  config: ResolvedLiminaInputs,
): MigrationConfigSource {
  return config.configPath === undefined
    ? { kind: 'defaults' }
    : { kind: 'file', configPath: config.configPath, discovery: 'explicit' };
}
function configDescription(source: MigrationConfigSource): string {
  return source.kind === 'file' ? source.configPath : 'none (using defaults)';
}
function sourceDescription(source: MigrationConfigSource): string {
  if (source.kind === 'defaults') return 'defaults';
  return source.discovery === 'explicit'
    ? 'explicit --config'
    : 'auto-discovered';
}
function showScope(scope: MigrationScope, flow: LiminaFlowReporter) {
  const tree = flow.tree('Migration scope');
  tree.start();
  const children = tree.children([
    `cwd: ${scope.cwd}`,
    `rootDir: ${scope.root.rootDir}`,
    `rootKind: ${scope.root.kind}`,
    `manifest: ${scope.root.manifestPath}`,
    `config: ${configDescription(scope.source)}`,
    `source: ${sourceDescription(scope.source)}`,
  ]);
  for (const child of children) child.pass();
  return tree;
}
async function isAcceptScope(yes: boolean | undefined): Promise<boolean> {
  return (
    yes === true ||
    isConfirmMigrationScope('Continue with this migration scope?')
  );
}
export async function confirmMigrationScope(
  scope: MigrationScope,
  options: { flow: LiminaFlowReporter; yes?: boolean },
): Promise<void> {
  const tree = showScope(scope, options.flow);
  const task = options.flow.start('Confirm migration scope');
  await task.pause();
  try {
    if (!(await isAcceptScope(options.yes)))
      throw new Error(
        'Migration scope declined or canceled; migration did not start.',
      );
    assertMigrationScopeUnchanged(scope);
    task.pass('Migration scope confirmed');
    tree.pass();
  } catch (error) {
    task.fail('Migration scope was not accepted', { error });
    throw error;
  } finally {
    task.resume();
  }
}
function assertLoadedRoot(
  config: ResolvedLiminaInputs,
  scope: MigrationScope,
): void {
  if (
    governanceBinding(config.governanceRoot) !== governanceBinding(scope.root)
  )
    throw new Error(
      'Migration governance root changed while loading configuration.',
    );
}
export async function loadMigrationScope(
  scope: MigrationScope,
  options: Pick<LoadConfigOptions, 'configLoader' | 'mode' | 'command'> = {},
): Promise<ResolvedLiminaInputs> {
  assertMigrationScopeUnchanged(scope);
  if (scope.source.kind === 'defaults') return createDefaultInputs(scope.root);
  const config = await loadConfig({
    ...options,
    configPath: scope.source.configPath,
    cwd: scope.cwd,
  });
  assertLoadedRoot(config, scope);
  assertMigrationScopeUnchanged(scope);
  return config;
}
