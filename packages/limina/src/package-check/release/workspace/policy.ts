import type {
  ReleaseContentHashConfigArgs,
  ResolvedLiminaConfig,
} from '#config/runner';
import { formatErrorMessage } from '../../../logger';
import {
  addContentHashFinding,
  formatDependencyLocation,
} from '../consistency/findings';
import type {
  ContentHashIgnoreRule,
  ReleaseConsistencyState,
} from '../consistency/types';
import {
  resolveReleaseContentHashBaselineTag,
  resolveReleaseContentHashIgnoreRules,
} from '../content-hash/config';

export interface ResolvedWorkspaceContentHashPolicy {
  baselineTag: string;
  ignoreRules: ContentHashIgnoreRule[];
}

interface WorkspacePolicyContext {
  args: ReleaseContentHashConfigArgs;
  config: ResolvedLiminaConfig;
  dependencyName: string;
  importerName: string;
  sourceManifestPath: string;
  state: ReleaseConsistencyState;
}

function getConfiguredPolicy(context: WorkspacePolicyContext) {
  const release = context.config.release;
  if (release === undefined) return {};
  const contentHash = release.contentHash;
  if (contentHash === undefined) return {};
  return {
    baselineTag: contentHash.baselineTag,
    builtinIgnore: contentHash.builtinIgnore,
    ignore: contentHash.ignore,
  };
}

function addPolicyFinding(options: {
  context: WorkspacePolicyContext;
  error: unknown;
  field: 'release.contentHash.baselineTag' | 'release.contentHash.ignore';
}): void {
  const errorMessage = formatErrorMessage(options.error);
  addContentHashFinding(options.context.state, {
    facts: {
      configField: options.field,
      dependencyName: options.context.dependencyName,
      errorMessage,
      importerName: options.context.importerName,
      kind: 'config-invalid',
      policy: getConfiguredPolicy(options.context),
      sourceManifestPath: options.context.sourceManifestPath,
    },
    filePath: options.context.config.configPath,
    message: [
      `${formatDependencyLocation(options.context)}: invalid release.contentHash config for ${options.context.dependencyName}:`,
      errorMessage,
    ].join(' '),
    packageManifestPath: options.context.sourceManifestPath,
    packageName: options.context.dependencyName,
  });
}

function resolveBaselineTag(context: WorkspacePolicyContext): string | null {
  try {
    return resolveReleaseContentHashBaselineTag(context.config, context.args);
  } catch (error) {
    addPolicyFinding({
      context,
      error,
      field: 'release.contentHash.baselineTag',
    });
    return null;
  }
}

function resolveIgnoreRules(
  context: WorkspacePolicyContext,
): ContentHashIgnoreRule[] | null {
  try {
    return resolveReleaseContentHashIgnoreRules(context.config, context.args);
  } catch (error) {
    addPolicyFinding({ context, error, field: 'release.contentHash.ignore' });
    return null;
  }
}

export function resolveWorkspaceContentHashPolicy(
  context: WorkspacePolicyContext,
): ResolvedWorkspaceContentHashPolicy | null {
  const baselineTag = resolveBaselineTag(context);
  if (baselineTag === null) return null;
  const ignoreRules = resolveIgnoreRules(context);
  if (ignoreRules === null) return null;
  return { baselineTag, ignoreRules };
}
