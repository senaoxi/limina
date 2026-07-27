import type { ResolvedLiminaConfig } from '#config/runner';
import {
  createExplicitMutationAuthority,
  createMechanicalExactMutationAuthority,
  MutationBoundaryError,
} from '#utils/mutation-boundary';
import { normalizeAbsolutePath } from '#utils/path';
import type { LiminaCheckIssue } from '../../../../source-check/snapshot';
import {
  createWorkspaceIssue,
  displayWorkspacePath,
  isInsideOrEqual,
} from '../shared';
import type { WorkspaceOutputMutationAuthority } from '../types';

function selectExplicitOutputTrustedBase(options: {
  activatedPackageRoots: readonly string[];
  configRoot: string;
  outputRoot: string;
}): string | null {
  const candidates = [options.configRoot, ...options.activatedPackageRoots]
    .map(normalizeAbsolutePath)
    .filter((candidate) => isInsideOrEqual(candidate, options.outputRoot))
    .sort((left, right) => right.length - left.length);
  return candidates[0] ?? null;
}

export async function createWorkspaceOutputMutationAuthority(options: {
  activatedPackageRoots: readonly string[];
  config: ResolvedLiminaConfig;
  declaringSourceConfig: string;
  outputRoot: string;
  workspaceGeneration: string;
}): Promise<WorkspaceOutputMutationAuthority> {
  const outputRoot = normalizeAbsolutePath(options.outputRoot);
  const trustedBase = selectExplicitOutputTrustedBase({
    activatedPackageRoots: options.activatedPackageRoots,
    configRoot: options.config.rootDir,
    outputRoot,
  });
  const authority =
    trustedBase === null
      ? await createMechanicalExactMutationAuthority({
          generation: options.workspaceGeneration,
          logicalMutationRoot: outputRoot,
          scope: 'directory',
        })
      : await createExplicitMutationAuthority({
          generation: options.workspaceGeneration,
          logicalMutationRoot: outputRoot,
          scope: 'directory',
          trustedBasePath: trustedBase,
        });
  return Object.freeze({
    authority,
    declaringSourceConfig: normalizeAbsolutePath(options.declaringSourceConfig),
    outputRoot,
    workspaceGeneration: options.workspaceGeneration,
  });
}

export function createOutputAuthorityIssue(options: {
  config: ResolvedLiminaConfig;
  declaredAt: string;
  error: unknown;
  outputRoot: string;
}): LiminaCheckIssue {
  const reason =
    options.error instanceof MutationBoundaryError
      ? options.error.message
      : `Unable to authenticate the output mutation root: ${String(options.error)}`;
  return createWorkspaceIssue({
    code: 'LIMINA_WORKSPACE_OUTPUT_ROOT_INVALID',
    config: options.config,
    evidence: [
      `declaration: ${displayWorkspacePath(options.config.rootDir, options.declaredAt)}`,
      `output root: ${displayWorkspacePath(options.config.rootDir, options.outputRoot)}`,
    ],
    filePath: options.declaredAt,
    fix: 'Choose a dedicated output path whose existing parent chain contains no symlink or junction.',
    reason,
    title: 'Workspace output root is structurally unsafe',
  });
}
