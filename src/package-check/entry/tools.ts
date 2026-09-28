import type { PackageAttwProfile, PackageEntry } from '#config/runner';
import { runAttwCheck } from '../attw-check';
import { runBoundaryCheck } from '../boundary-check';
import type { DistPackageJson } from '../manifest';
import { runPublintCheck } from '../publint-check';
import type { RunPackageCheckEntryOptions } from '../runner-types';
import {
  getPackageAttwCheckConfig,
  getPackagePublintCheckConfig,
} from '../tool-config';
import {
  applyToolResult,
  type EntryExecutionState,
  requireTarball,
} from './state';

interface EntryToolOptions {
  entry: PackageEntry;
  manifest: DistPackageJson;
  manifestPath: string;
  runOptions: RunPackageCheckEntryOptions;
  state: EntryExecutionState;
}

function isEnabled(
  options: EntryToolOptions,
  tool: 'attw' | 'boundary' | 'publint',
): boolean {
  return options.runOptions.checks.includes(tool);
}

function getToolDepth(options: EntryToolOptions): number {
  return (options.runOptions.flowDepth ?? 0) + 1;
}

export async function runPublint(options: EntryToolOptions): Promise<void> {
  if (!isEnabled(options, 'publint')) return;
  const result = await runPublintCheck({
    config: getPackagePublintCheckConfig(options.entry),
    flow: options.runOptions.flow,
    flowDepth: getToolDepth(options),
    issueSink: options.runOptions.issueSink,
    label: options.runOptions.label,
    packageManifestPath: options.manifestPath,
    packageName: options.manifest.name,
    rootDir: options.runOptions.config.rootDir,
    tarball: requireTarball(options.state),
  });
  applyToolResult(options.state, result);
}

function getAttwProfile(options: {
  configuredProfile: PackageAttwProfile | undefined;
  requestedProfile: PackageAttwProfile | undefined;
}): PackageAttwProfile {
  if (options.requestedProfile !== undefined) return options.requestedProfile;
  if (options.configuredProfile !== undefined) return options.configuredProfile;
  return 'esm-only';
}

export async function runAttw(options: EntryToolOptions): Promise<void> {
  if (!isEnabled(options, 'attw')) return;
  const config = getPackageAttwCheckConfig(options.entry);
  const profile = getAttwProfile({
    configuredProfile: config.profile,
    requestedProfile: options.runOptions.attwProfile,
  });
  const result = await runAttwCheck({
    config,
    flow: options.runOptions.flow,
    flowDepth: getToolDepth(options),
    issueSink: options.runOptions.issueSink,
    label: options.runOptions.label,
    packageManifestPath: options.manifestPath,
    packageName: options.manifest.name,
    profile,
    rootDir: options.runOptions.config.rootDir,
    tarball: requireTarball(options.state),
  });
  applyToolResult(options.state, result);
}

export async function runBoundary(options: EntryToolOptions): Promise<void> {
  if (!isEnabled(options, 'boundary')) return;
  const passed = await runBoundaryCheck({
    checkOptions: {
      flow: options.runOptions.flow,
      flowDepth: getToolDepth(options),
      issueSink: options.runOptions.issueSink,
      packageManifestPath: options.manifestPath,
      packageName: options.manifest.name,
      rootDir: options.runOptions.config.rootDir,
    },
    label: options.runOptions.label,
    target: { ...options.entry.boundary, outDir: options.entry.outDir },
  });
  applyToolResult(options.state, passed ? 'passed' : 'failed');
}

export async function runEntryTools(options: EntryToolOptions): Promise<void> {
  await runPublint(options);
  await runAttw(options);
  await runBoundary(options);
}
