import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import type { WorkspacePackage } from '#core/workspace/actions';
import { isNamedWorkspacePackage } from '#core/workspace/actions';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import { formatUnknownValue, isPlainRecord } from '#utils/values';
import path from 'pathe';
import { createSourceKnipConfigFinding, type SourceFinding } from './findings';
import type { KnipSourceAnalysisGroup } from './knip';

export type SourceKnipWorkspaceConfigRecord = Record<string, unknown>;

const sourceKnipWorkspaceConfigKeys = new Set([
  'entry',
  'ignoreDependencies',
  'ignoreFiles',
]);

export function formatSourceKnipWorkspaceField(packageName: string): string {
  return `source.knip.workspaces[${JSON.stringify(packageName)}]`;
}

export function collectSourceKnipWorkspaceConfigs(options: {
  config: ResolvedLiminaConfig;
  findings: SourceFinding[];
  workspacePackages: WorkspacePackage[];
}): Map<string, SourceKnipWorkspaceConfigRecord> {
  const workspaceConfigs = new Map<string, SourceKnipWorkspaceConfigRecord>();
  const rawKnipConfig = options.config.source?.knip;

  if (!isPlainRecord(rawKnipConfig)) {
    return workspaceConfigs;
  }

  const rawWorkspaces = rawKnipConfig.workspaces;

  if (rawWorkspaces === undefined) {
    return workspaceConfigs;
  }

  if (!isPlainRecord(rawWorkspaces)) {
    const field = 'source.knip.workspaces';
    const title = 'Invalid source Knip workspace config';
    const reason =
      'workspaces must be an object keyed by workspace package name.';
    const lines = [
      `${title}:`,
      `  field: ${field}`,
      `  value: ${formatUnknownValue(rawWorkspaces)}`,
      `  reason: ${reason}`,
    ];
    options.findings.push(
      createSourceKnipConfigFinding({
        field,
        kind: 'workspace',
        lines,
        reason,
        title,
        value: rawWorkspaces,
      }),
    );
    return workspaceConfigs;
  }

  const workspacePackageNames = new Set(
    options.workspacePackages
      .filter(isNamedWorkspacePackage)
      .map((workspacePackage) => workspacePackage.name),
  );
  const packageManifestPathByName = new Map(
    options.workspacePackages
      .filter(isNamedWorkspacePackage)
      .map((entry) => [
        entry.name,
        normalizeAbsolutePath(path.join(entry.directory, 'package.json')),
      ]),
  );

  for (const [rawPackageName, rawWorkspaceConfig] of Object.entries(
    rawWorkspaces,
  )) {
    const packageName = rawPackageName.trim();
    const field = formatSourceKnipWorkspaceField(rawPackageName);

    if (packageName.length === 0) {
      const title = 'Invalid source Knip workspace config';
      const reason = 'workspace config keys must be non-empty package names.';
      const lines = [`${title}:`, `  field: ${field}`, `  reason: ${reason}`];
      options.findings.push(
        createSourceKnipConfigFinding({
          field,
          kind: 'workspace',
          lines,
          reason,
          title,
          value: rawPackageName,
        }),
      );
      continue;
    }

    if (!workspacePackageNames.has(packageName)) {
      const title = 'Invalid source Knip workspace config';
      const reason =
        'workspace config keys must name packages discovered in the pnpm workspace.';
      const lines = [
        `${title}:`,
        `  field: ${field}`,
        `  package: ${packageName}`,
        `  reason: ${reason}`,
      ];
      options.findings.push(
        createSourceKnipConfigFinding({
          field,
          kind: 'workspace',
          lines,
          packageName,
          reason,
          title,
        }),
      );
      continue;
    }

    if (!isPlainRecord(rawWorkspaceConfig)) {
      const title = 'Invalid source Knip workspace config';
      const reason = 'workspace config values must be objects.';
      const lines = [
        `${title}:`,
        `  field: ${field}`,
        `  value: ${formatUnknownValue(rawWorkspaceConfig)}`,
        `  reason: ${reason}`,
      ];
      options.findings.push(
        createSourceKnipConfigFinding({
          field,
          kind: 'workspace',
          lines,
          packageJsonPath: packageManifestPathByName.get(packageName),
          packageName,
          reason,
          title,
          value: rawWorkspaceConfig,
        }),
      );
      continue;
    }

    for (const key of Object.keys(rawWorkspaceConfig)) {
      if (sourceKnipWorkspaceConfigKeys.has(key)) {
        continue;
      }

      const invalidField = `${field}.${key}`;
      const title = 'Invalid source Knip workspace config';
      const reason = 'unknown source Knip workspace config field.';
      const value = rawWorkspaceConfig[key];
      const lines = [
        `${title}:`,
        `  field: ${invalidField}`,
        `  value: ${formatUnknownValue(value)}`,
        `  reason: ${reason}`,
      ];
      options.findings.push(
        createSourceKnipConfigFinding({
          field: invalidField,
          kind: 'workspace',
          lines,
          packageJsonPath: packageManifestPathByName.get(packageName),
          packageName,
          reason,
          title,
          value,
        }),
      );
    }

    workspaceConfigs.set(packageName, rawWorkspaceConfig);
  }

  return workspaceConfigs;
}

export function createKnipSourceAnalysisGroups(options: {
  config: ResolvedLiminaConfig;
  generatedGraph: GeneratedTsconfigGraphResult;
  requiredWorkspaceNames: Set<string>;
  workspacePackages: WorkspacePackage[];
}): KnipSourceAnalysisGroup[] {
  if (options.workspacePackages.length === 0) {
    return [{}];
  }

  const generatedConfigByPackageName = new Map(
    options.generatedGraph.generatedKnipConfigs.flatMap((entry) =>
      entry.packageName ? [[entry.packageName, entry] as const] : [],
    ),
  );
  const defaultWorkspaceNames: string[] = [];
  const groups: KnipSourceAnalysisGroup[] = [];

  for (const workspacePackage of options.workspacePackages.filter(
    isNamedWorkspacePackage,
  )) {
    if (!options.requiredWorkspaceNames.has(workspacePackage.name)) {
      continue;
    }

    const generatedConfig = generatedConfigByPackageName.get(
      workspacePackage.name,
    );

    if (!generatedConfig) {
      defaultWorkspaceNames.push(workspacePackage.name);
      continue;
    }

    groups.push(
      ...collectRealKnipConfigReferences(
        generatedConfig.references,
        options.generatedGraph.generatedFiles,
      ).map((reference) => ({
        tsConfigFile: toRelativePath(workspacePackage.directory, reference),
        workspaceNames: [workspacePackage.name],
      })),
    );
  }

  return [
    ...(defaultWorkspaceNames.length > 0
      ? [
          {
            workspaceNames: defaultWorkspaceNames,
          },
        ]
      : []),
    ...groups,
  ];
}

function collectRealKnipConfigReferences(
  references: readonly string[],
  virtualFiles: ReadonlyMap<string, string>,
): string[] {
  const realReferences = new Set<string>();
  const seen = new Set<string>();
  const pending = references.map(normalizeAbsolutePath);

  for (const configPath of pending) {
    if (seen.has(configPath)) {
      continue;
    }

    seen.add(configPath);
    const content = virtualFiles.get(configPath);

    if (!content) {
      realReferences.add(configPath);
      continue;
    }

    const config = JSON.parse(content) as {
      extends?: unknown;
      references?: readonly { readonly path?: unknown }[];
    };

    if (typeof config.extends === 'string') {
      pending.push(
        normalizeAbsolutePath(
          path.resolve(path.dirname(configPath), config.extends),
        ),
      );
    }

    for (const reference of config.references ?? []) {
      if (typeof reference.path === 'string') {
        pending.push(
          normalizeAbsolutePath(
            path.resolve(path.dirname(configPath), reference.path),
          ),
        );
      }
    }
  }

  return [...realReferences].sort();
}
