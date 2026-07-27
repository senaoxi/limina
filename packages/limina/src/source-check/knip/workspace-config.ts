import type { ResolvedLiminaConfig } from '#config/runner';
import {
  isNamedWorkspacePackage,
  type WorkspacePackage,
} from '#core/workspace/actions';
import { normalizeAbsolutePath } from '#utils/path';
import { formatUnknownValue, isPlainRecord } from '#utils/values';
import path from 'pathe';
import { createSourceKnipConfigFinding, type SourceFinding } from '../findings';

export type SourceKnipWorkspaceConfigRecord = Record<string, unknown>;

const sourceKnipWorkspaceConfigKeys = new Set([
  'entry',
  'ignoreDependencies',
  'ignoreFiles',
]);

interface WorkspaceConfigContext {
  findings: SourceFinding[];
  packageManifestPathByName: ReadonlyMap<string, string>;
  workspaceConfigs: Map<string, SourceKnipWorkspaceConfigRecord>;
  workspacePackageNames: ReadonlySet<string>;
}

interface WorkspaceConfigEntry {
  field: string;
  packageName: string;
  rawPackageName: string;
  rawWorkspaceConfig: unknown;
}

type WorkspaceEntryValidator = (
  entry: WorkspaceConfigEntry,
  context: WorkspaceConfigContext,
) => SourceFinding | null;

export function formatSourceKnipWorkspaceField(packageName: string): string {
  return `source.knip.workspaces[${JSON.stringify(packageName)}]`;
}

function createWorkspaceConfigFinding(options: {
  field: string;
  packageJsonPath?: string;
  packageName?: string;
  reason: string;
  value?: unknown;
}): SourceFinding {
  const title = 'Invalid source Knip workspace config';
  const lines = [
    `${title}:`,
    `  field: ${options.field}`,
    ...(options.packageName === undefined
      ? []
      : [`  package: ${options.packageName}`]),
    ...(options.value === undefined
      ? []
      : [`  value: ${formatUnknownValue(options.value)}`]),
    `  reason: ${options.reason}`,
  ];

  return createSourceKnipConfigFinding({
    field: options.field,
    kind: 'workspace',
    lines,
    packageJsonPath: options.packageJsonPath,
    packageName: options.packageName,
    reason: options.reason,
    title,
    value: options.value,
  });
}

function getRawWorkspaces(config: ResolvedLiminaConfig): unknown {
  const source = config.source;

  if (source === undefined) {
    return undefined;
  }

  const knip = source.knip;
  return isPlainRecord(knip) ? knip.workspaces : undefined;
}

function resolveWorkspaceRecord(options: {
  config: ResolvedLiminaConfig;
  findings: SourceFinding[];
}): Record<string, unknown> | null {
  const rawWorkspaces = getRawWorkspaces(options.config);

  if (rawWorkspaces === undefined) {
    return null;
  }

  if (isPlainRecord(rawWorkspaces)) {
    return rawWorkspaces;
  }

  options.findings.push(
    createWorkspaceConfigFinding({
      field: 'source.knip.workspaces',
      reason: 'workspaces must be an object keyed by workspace package name.',
      value: rawWorkspaces,
    }),
  );
  return null;
}

function createWorkspacePackageNames(
  workspacePackages: readonly WorkspacePackage[],
): Set<string> {
  return new Set(
    workspacePackages
      .filter(isNamedWorkspacePackage)
      .map((workspacePackage) => workspacePackage.name),
  );
}

function createPackageManifestPaths(
  workspacePackages: readonly WorkspacePackage[],
): Map<string, string> {
  return new Map(
    workspacePackages
      .filter(isNamedWorkspacePackage)
      .map((entry) => [
        entry.name,
        normalizeAbsolutePath(path.join(entry.directory, 'package.json')),
      ]),
  );
}

function validatePackageName(
  entry: WorkspaceConfigEntry,
): SourceFinding | null {
  if (entry.packageName.length > 0) {
    return null;
  }

  return createWorkspaceConfigFinding({
    field: entry.field,
    reason: 'workspace config keys must be non-empty package names.',
    value: entry.rawPackageName,
  });
}

function validateKnownPackage(
  entry: WorkspaceConfigEntry,
  context: WorkspaceConfigContext,
): SourceFinding | null {
  if (context.workspacePackageNames.has(entry.packageName)) {
    return null;
  }

  return createWorkspaceConfigFinding({
    field: entry.field,
    packageName: entry.packageName,
    reason:
      'workspace config keys must name packages discovered in the pnpm workspace.',
  });
}

function validateWorkspaceConfigObject(
  entry: WorkspaceConfigEntry,
  context: WorkspaceConfigContext,
): SourceFinding | null {
  if (isPlainRecord(entry.rawWorkspaceConfig)) {
    return null;
  }

  return createWorkspaceConfigFinding({
    field: entry.field,
    packageJsonPath: context.packageManifestPathByName.get(entry.packageName),
    packageName: entry.packageName,
    reason: 'workspace config values must be objects.',
    value: entry.rawWorkspaceConfig,
  });
}

const workspaceEntryValidators: readonly WorkspaceEntryValidator[] = [
  validatePackageName,
  validateKnownPackage,
  validateWorkspaceConfigObject,
];

function findWorkspaceEntryFinding(
  entry: WorkspaceConfigEntry,
  context: WorkspaceConfigContext,
): SourceFinding | null {
  for (const validate of workspaceEntryValidators) {
    const finding = validate(entry, context);

    if (finding !== null) {
      return finding;
    }
  }

  return null;
}

function addUnknownFieldFindings(
  entry: WorkspaceConfigEntry,
  context: WorkspaceConfigContext,
  workspaceConfig: SourceKnipWorkspaceConfigRecord,
): void {
  for (const key of Object.keys(workspaceConfig)) {
    if (sourceKnipWorkspaceConfigKeys.has(key)) {
      continue;
    }

    context.findings.push(
      createWorkspaceConfigFinding({
        field: `${entry.field}.${key}`,
        packageJsonPath: context.packageManifestPathByName.get(
          entry.packageName,
        ),
        packageName: entry.packageName,
        reason: 'unknown source Knip workspace config field.',
        value: workspaceConfig[key],
      }),
    );
  }
}

function processWorkspaceEntry(
  entry: WorkspaceConfigEntry,
  context: WorkspaceConfigContext,
): void {
  const finding = findWorkspaceEntryFinding(entry, context);

  if (finding !== null) {
    context.findings.push(finding);
    return;
  }

  const workspaceConfig =
    entry.rawWorkspaceConfig as SourceKnipWorkspaceConfigRecord;
  addUnknownFieldFindings(entry, context, workspaceConfig);
  context.workspaceConfigs.set(entry.packageName, workspaceConfig);
}

function createWorkspaceConfigEntry(
  rawPackageName: string,
  rawWorkspaceConfig: unknown,
): WorkspaceConfigEntry {
  return {
    field: formatSourceKnipWorkspaceField(rawPackageName),
    packageName: rawPackageName.trim(),
    rawPackageName,
    rawWorkspaceConfig,
  };
}

export function collectSourceKnipWorkspaceConfigs(options: {
  config: ResolvedLiminaConfig;
  findings: SourceFinding[];
  workspacePackages: WorkspacePackage[];
}): Map<string, SourceKnipWorkspaceConfigRecord> {
  const workspaceConfigs = new Map<string, SourceKnipWorkspaceConfigRecord>();
  const rawWorkspaces = resolveWorkspaceRecord(options);

  if (rawWorkspaces === null) {
    return workspaceConfigs;
  }

  const context: WorkspaceConfigContext = {
    findings: options.findings,
    packageManifestPathByName: createPackageManifestPaths(
      options.workspacePackages,
    ),
    workspaceConfigs,
    workspacePackageNames: createWorkspacePackageNames(
      options.workspacePackages,
    ),
  };

  for (const [rawPackageName, rawWorkspaceConfig] of Object.entries(
    rawWorkspaces,
  )) {
    processWorkspaceEntry(
      createWorkspaceConfigEntry(rawPackageName, rawWorkspaceConfig),
      context,
    );
  }

  return workspaceConfigs;
}
