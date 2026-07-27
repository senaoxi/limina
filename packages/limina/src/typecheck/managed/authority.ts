import {
  assertMutationAuthority,
  createExplicitMutationAuthority,
  type MutationAuthority,
} from '#utils/mutation-boundary';
import { isPathInsideDirectory, normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import type {
  ValidatedWorkspaceContext,
  WorkspaceOutputMutationAuthority,
} from '../../core/workspace/validated-context';
import {
  assertLiminaArtifactNamespace,
  type LiminaArtifactNamespace,
} from '../../domain/artifacts/namespace';
import { ManagedCheckerEmitBoundaryError } from './types';

function isInsideOrEqual(parentPath: string, childPath: string): boolean {
  const parent = normalizeAbsolutePath(parentPath);
  const child = normalizeAbsolutePath(childPath);
  if (parent === child) return true;
  return isPathInsideDirectory(child, parent);
}

function requireOutputAuthority(options: {
  sourceConfigPath: string;
  workspaceContext: ValidatedWorkspaceContext;
}): WorkspaceOutputMutationAuthority {
  const capability = options.workspaceContext.outputMutationAuthorities?.get(
    options.sourceConfigPath,
  );
  if (capability !== undefined) return capability;
  throw new ManagedCheckerEmitBoundaryError(
    `Missing validated output mutation authority for ${options.sourceConfigPath}.`,
  );
}

function assertOutputAuthorityGeneration(options: {
  capability: WorkspaceOutputMutationAuthority;
  sourceConfigPath: string;
  workspaceContext: ValidatedWorkspaceContext;
}): void {
  if (
    options.capability.workspaceGeneration ===
    options.workspaceContext.workspaceMutationGeneration
  ) {
    return;
  }
  throw new ManagedCheckerEmitBoundaryError(
    `Output mutation authority binding drifted for ${options.sourceConfigPath}.`,
  );
}

function assertOutputAuthorityPaths(options: {
  capability: WorkspaceOutputMutationAuthority;
  outputRoot: string;
  sourceConfigPath: string;
}): void {
  if (options.capability.declaringSourceConfig !== options.sourceConfigPath) {
    throw new ManagedCheckerEmitBoundaryError(
      `Output mutation authority binding drifted for ${options.sourceConfigPath}.`,
    );
  }
  if (options.capability.outputRoot === options.outputRoot) return;
  throw new ManagedCheckerEmitBoundaryError(
    `Output mutation authority binding drifted for ${options.sourceConfigPath}.`,
  );
}

export function resolveOutputAuthority(options: {
  outputRoot: string;
  sourceConfigPath: string;
  workspaceContext: ValidatedWorkspaceContext;
}): WorkspaceOutputMutationAuthority {
  const sourceConfigPath = normalizeAbsolutePath(options.sourceConfigPath);
  const outputRoot = normalizeAbsolutePath(options.outputRoot);
  const capability = requireOutputAuthority({
    sourceConfigPath,
    workspaceContext: options.workspaceContext,
  });
  assertOutputAuthorityGeneration({
    capability,
    sourceConfigPath,
    workspaceContext: options.workspaceContext,
  });
  assertOutputAuthorityPaths({ capability, outputRoot, sourceConfigPath });
  assertMutationAuthority(capability.authority);
  return capability;
}

function getArtifactExpectedRoot(options: {
  artifactNamespace: LiminaArtifactNamespace;
  expectedNamespace: string;
}): string {
  return normalizeAbsolutePath(
    path.join(options.artifactNamespace.rootDir, options.expectedNamespace),
  );
}

function getArtifactGeneration(
  artifactNamespace: LiminaArtifactNamespace,
): string {
  return `${artifactNamespace.generation}:${artifactNamespace.generationToken.nonce}`;
}

export async function createArtifactDirectoryAuthority(options: {
  artifactNamespace: LiminaArtifactNamespace;
  directoryPath: string;
  expectedNamespace: string;
}): Promise<MutationAuthority> {
  assertLiminaArtifactNamespace(options.artifactNamespace);
  const directoryPath = normalizeAbsolutePath(options.directoryPath);
  const expectedRoot = getArtifactExpectedRoot(options);
  if (!isInsideOrEqual(expectedRoot, directoryPath)) {
    throw new ManagedCheckerEmitBoundaryError(
      `Managed checker directory escapes its artifact runtime authority: ${directoryPath}.`,
    );
  }
  return createExplicitMutationAuthority({
    generation: getArtifactGeneration(options.artifactNamespace),
    logicalMutationRoot: directoryPath,
    scope: 'directory',
    trustedBasePath: options.artifactNamespace.configRootDir,
  });
}

function assertArtifactFilePath(expectedRoot: string, filePath: string): void {
  if (!isInsideOrEqual(expectedRoot, filePath)) {
    throw new ManagedCheckerEmitBoundaryError(
      `Managed checker file escapes its artifact runtime authority: ${filePath}.`,
    );
  }
  if (filePath === expectedRoot) {
    throw new ManagedCheckerEmitBoundaryError(
      `Managed checker file escapes its artifact runtime authority: ${filePath}.`,
    );
  }
}

export async function createArtifactFileAuthority(options: {
  artifactNamespace: LiminaArtifactNamespace;
  expectedNamespace: string;
  filePath: string;
}): Promise<MutationAuthority> {
  assertLiminaArtifactNamespace(options.artifactNamespace);
  const filePath = normalizeAbsolutePath(options.filePath);
  assertArtifactFilePath(getArtifactExpectedRoot(options), filePath);
  return createExplicitMutationAuthority({
    generation: getArtifactGeneration(options.artifactNamespace),
    logicalMutationRoot: filePath,
    scope: 'file',
    trustedBasePath: options.artifactNamespace.configRootDir,
  });
}

export function assertProjectedInside(options: {
  authorityRoot: string;
  configPath: string;
  outputPath: string;
}): void {
  if (isInsideOrEqual(options.authorityRoot, options.outputPath)) return;
  throw new ManagedCheckerEmitBoundaryError(
    [
      'Managed checker projected an output outside its authenticated authority:',
      `  config: ${options.configPath}`,
      `  output: ${options.outputPath}`,
      `  authority root: ${options.authorityRoot}`,
    ].join('\n'),
  );
}

export { isInsideOrEqual };
