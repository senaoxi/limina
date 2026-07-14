import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import type { WorkspacePackage } from '#core/workspace/actions';
import { isNamedWorkspacePackage } from '#core/workspace/actions';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import { formatUnknownValue, isPlainRecord } from '#utils/values';
import path from 'pathe';
import type { KnipSourceAnalysisGroup } from './knip';

export type SourceKnipWorkspaceConfigRecord = Record<string, unknown>;

export function formatSourceKnipWorkspaceField(packageName: string): string {
  return `source.knip.workspaces[${JSON.stringify(packageName)}]`;
}

export function collectSourceKnipWorkspaceConfigs(options: {
  config: ResolvedLiminaConfig;
  problems: string[];
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
    options.problems.push(
      [
        'Invalid source Knip workspace config:',
        '  field: source.knip.workspaces',
        `  value: ${formatUnknownValue(rawWorkspaces)}`,
        '  reason: workspaces must be an object keyed by workspace package name.',
      ].join('\n'),
    );
    return workspaceConfigs;
  }

  const workspacePackageNames = new Set(
    options.workspacePackages
      .filter(isNamedWorkspacePackage)
      .map((workspacePackage) => workspacePackage.name),
  );

  for (const [rawPackageName, rawWorkspaceConfig] of Object.entries(
    rawWorkspaces,
  )) {
    const packageName = rawPackageName.trim();
    const field = formatSourceKnipWorkspaceField(rawPackageName);

    if (packageName.length === 0) {
      options.problems.push(
        [
          'Invalid source Knip workspace config:',
          `  field: ${field}`,
          '  reason: workspace config keys must be non-empty package names.',
        ].join('\n'),
      );
      continue;
    }

    if (!workspacePackageNames.has(packageName)) {
      options.problems.push(
        [
          'Invalid source Knip workspace config:',
          `  field: ${field}`,
          `  package: ${packageName}`,
          '  reason: workspace config keys must name packages discovered in the pnpm workspace.',
        ].join('\n'),
      );
      continue;
    }

    if (!isPlainRecord(rawWorkspaceConfig)) {
      options.problems.push(
        [
          'Invalid source Knip workspace config:',
          `  field: ${field}`,
          `  value: ${formatUnknownValue(rawWorkspaceConfig)}`,
          '  reason: workspace config values must be objects.',
        ].join('\n'),
      );
      continue;
    }

    if (Object.hasOwn(rawWorkspaceConfig, 'tsConfig')) {
      options.problems.push(
        [
          'Unsupported source Knip workspace config:',
          `  field: ${field}.tsConfig`,
          '  reason: tsConfig is no longer supported. Limina uses Knip default tsconfig behavior unless a package has a static limina build script.',
          '  fix: remove tsConfig, or add a static package script such as "build": "limina build tsconfig.json" when this package needs a specific Knip tsconfig source.',
        ].join('\n'),
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
