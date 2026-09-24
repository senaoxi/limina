import type { ResolvedLiminaConfig } from '#config/runner';
import {
  getManifestPackageName,
  type WorkspacePackage,
} from '#core/workspace/actions';
import { formatUnknownValue, isPlainRecord } from '#utils/values';
import path from 'pathe';
import {
  getPackageOwnerIdentity,
  type PackageOwnerIdentity,
} from '../../core/workspace/owner-identity';
import type { ValidatedWorkspaceContext } from '../../core/workspace/validated-context';
import { createSourceKnipConfigFinding, type SourceFinding } from '../findings';

export interface SourceKnipWorkspaceConfigRecord
  extends Record<string, unknown> {
  readonly field: string;
  readonly owner: WorkspacePackage;
  readonly ownerIdentity: PackageOwnerIdentity;
}
const sourceKnipWorkspaceConfigKeys = new Set([
  'entry',
  'ignoreDependencies',
  'ignoreFiles',
]);

export function formatSourceKnipWorkspaceField(packageName: string): string {
  return `source.knip.workspaces[${JSON.stringify(packageName)}]`;
}

function configValueLines(value: unknown): string[] {
  return value === undefined ? [] : [`  value: ${formatUnknownValue(value)}`];
}

function configFinding(options: {
  field: string;
  reason: string;
  value?: unknown;
  owner?: WorkspacePackage;
}): SourceFinding {
  const title = 'Invalid source Knip workspace config';
  return createSourceKnipConfigFinding({
    field: options.field,
    kind: 'workspace',
    title,
    packageJsonPath:
      options.owner === undefined
        ? undefined
        : path.join(options.owner.directory, 'package.json'),
    packageName: options.owner?.name,
    reason: options.reason,
    value: options.value,
    lines: [
      `${title}:`,
      `  field: ${options.field}`,
      `  reason: ${options.reason}`,
      ...configValueLines(options.value),
    ],
  });
}

function addOwnerConfig(options: {
  configs: Map<PackageOwnerIdentity, SourceKnipWorkspaceConfigRecord>;
  field: string;
  findings: SourceFinding[];
  owner: WorkspacePackage | undefined;
  raw: unknown;
  workspaceContext: ValidatedWorkspaceContext;
}): void {
  if (options.owner === undefined) {
    options.findings.push(
      configFinding({
        field: options.field,
        reason:
          'config must select an activated package; source.knip.root cannot activate an excluded root.',
      }),
    );
    return;
  }
  if (!isPlainRecord(options.raw)) {
    options.findings.push(
      configFinding({
        ...options,
        reason: 'workspace config values must be objects.',
        value: options.raw,
      }),
    );
    return;
  }
  addUnknownOwnerFields({ ...options, raw: options.raw });
  const ownerIdentity = getPackageOwnerIdentity(
    options.workspaceContext,
    options.owner.directory,
  );
  options.configs.set(ownerIdentity, {
    ...options.raw,
    field: options.field,
    owner: options.owner,
    ownerIdentity,
  });
}

function addUnknownOwnerFields(
  options: Parameters<typeof addOwnerConfig>[0] & {
    raw: Record<string, unknown>;
  },
): void {
  for (const key of Object.keys(options.raw)) {
    if (!sourceKnipWorkspaceConfigKeys.has(key))
      options.findings.push(
        configFinding({
          ...options,
          field: `${options.field}.${key}`,
          reason: 'unknown source Knip workspace config field.',
          value: options.raw[key],
        }),
      );
  }
}

function addNamedConfigs(options: {
  config: ResolvedLiminaConfig;
  configs: Map<PackageOwnerIdentity, SourceKnipWorkspaceConfigRecord>;
  findings: SourceFinding[];
  raw: unknown;
  workspaceContext: ValidatedWorkspaceContext;
}): void {
  if (options.raw === undefined) return;
  if (!isPlainRecord(options.raw)) {
    options.findings.push(
      configFinding({
        field: 'source.knip.workspaces',
        reason: 'workspaces must be an object keyed by workspace package name.',
        value: options.raw,
      }),
    );
    return;
  }
  addNamedConfigEntries({ ...options, raw: options.raw });
}

function addNamedConfigEntries(
  options: Parameters<typeof addNamedConfigs>[0] & {
    raw: Record<string, unknown>;
  },
): void {
  for (const [name, raw] of Object.entries(options.raw))
    addNamedConfig({ ...options, name, raw });
}

function addNamedConfig(
  options: Parameters<typeof addNamedConfigs>[0] & { name: string },
): void {
  const field = formatSourceKnipWorkspaceField(options.name);
  if (isRootName(options.config, options.name.trim())) {
    options.findings.push(
      configFinding({
        field,
        reason:
          'The governance root package must be configured through source.knip.root.',
      }),
    );
    return;
  }
  const owner = findNamedOwner(options);
  if (owner === undefined) {
    options.findings.push(
      configFinding({
        field,
        reason:
          'workspace config keys must name packages discovered in the workspace and activated for this run.',
      }),
    );
    return;
  }
  addOwnerConfig({ ...options, owner, field });
}

function isRootName(config: ResolvedLiminaConfig, name: string): boolean {
  return (
    name === '.' ||
    name === getManifestPackageName(config.governanceRoot.manifest)
  );
}

function findNamedOwner(
  options: Parameters<typeof addNamedConfig>[0],
): WorkspacePackage | undefined {
  const name = options.name.trim();
  if (name.length === 0) return undefined;
  return options.workspaceContext.packages.find(
    (entry) =>
      entry.directory !== options.config.governanceRoot.rootDir &&
      entry.name === name,
  );
}

function getKnipConfig(config: ResolvedLiminaConfig): unknown {
  return config.source?.knip;
}

/** Public name/root addressing ends here; downstream keys are validated owners. */
export function collectSourceKnipWorkspaceConfigs(options: {
  config: ResolvedLiminaConfig;
  findings: SourceFinding[];
  workspaceContext: ValidatedWorkspaceContext;
}): Map<PackageOwnerIdentity, SourceKnipWorkspaceConfigRecord> {
  const configs = new Map<
    PackageOwnerIdentity,
    SourceKnipWorkspaceConfigRecord
  >();
  const knip = getKnipConfig(options.config);
  if (!isPlainRecord(knip)) return configs;
  if (Object.hasOwn(knip, 'root'))
    addOwnerConfig({
      ...options,
      configs,
      field: 'source.knip.root',
      raw: knip.root,
      owner: options.workspaceContext.packages.find(
        (entry) => entry.directory === options.config.governanceRoot.rootDir,
      ),
    });
  addNamedConfigs({ ...options, configs, raw: knip.workspaces });
  return configs;
}
