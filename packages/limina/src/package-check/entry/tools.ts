import type { PackageAttwProfile, PackageEntry } from '#config/runner';
import { runAttwCheck } from '../attw-check';
import { isRunBoundaryCheck } from '../boundary-check';
import type { DistPackageJson as DistributionPackageJson } from '../manifest';
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
  manifest: DistributionPackageJson;
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
  return options.configuredProfile === undefined
    ? 'esm-only'
    : options.configuredProfile;
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
  const isPassed = await isRunBoundaryCheck({
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
  applyToolResult(options.state, isPassed ? 'passed' : 'failed');
}

export async function runEntryTools(options: EntryToolOptions): Promise<void> {
  await runPublint(options);
  await runAttw(options);
  await runBoundary(options);
}
