import { createHash } from 'node:crypto';
import type {
  ProjectDependencyRequest,
  ProjectSemanticContext,
} from './contracts';

export const PROJECT_DEPENDENCY_ADAPTER_VERSION =
  'service-script-facts-v6-resolution-evidence';

const workspaceBoundarySnapshotIdentities = new WeakMap<
  ProjectSemanticContext['workspaceSourceBoundary'],
  string
>();

export function getWorkspaceSourceBoundarySnapshotIdentity(
  boundary: ProjectSemanticContext['workspaceSourceBoundary'],
): string {
  const cached = workspaceBoundarySnapshotIdentities.get(boundary);
  if (cached !== undefined) return cached;
  // The membership identity contains every workspace path. Copying it into
  // every occurrence/cache clone multiplies workspace size by import count.
  const identity = `workspace-source-boundary:${createHash('sha256')
    .update(boundary.identity)
    .digest('hex')}`;
  workspaceBoundarySnapshotIdentities.set(boundary, identity);
  return identity;
}

function getAstroCacheIdentity(context: ProjectSemanticContext): string | null {
  return context.astroSemanticProject?.seed.id ?? null;
}

function getSvelteCacheIdentity(context: ProjectSemanticContext) {
  const project = context.svelteSemanticProject;
  return project === undefined
    ? null
    : {
        adapterVersion: project.adapterVersion,
        configClosure: project.configClosure,
        packageIdentity: project.packageIdentity,
        options: project.options,
        generation: project.generation,
      };
}

function getVueCacheIdentity(context: ProjectSemanticContext): string | null {
  return context.vueSemanticIdentity?.id ?? null;
}

export function createProjectSemanticCacheIdentity(
  context: ProjectSemanticContext,
): string {
  const canonicalIdentity = JSON.stringify({
    adapterContractVersion: PROJECT_DEPENDENCY_ADAPTER_VERSION,
    astro: getAstroCacheIdentity(context),
    authority: context.semanticAuthority,
    configPath: context.configPath,
    compilerOptions: context.compilerOptions,
    extensions: context.extensions,
    packageRootDir: context.packageRootDir,
    references: context.references,
    fileNames: context.fileNames,
    generation: context.generation,
    packageRoots: [...context.packageRootByFileName.entries()].sort(
      ([left], [right]) => left.localeCompare(right),
    ),
    resolverConfigPath: context.resolverConfigPath,
    svelte: getSvelteCacheIdentity(context),
    vue: getVueCacheIdentity(context),
    workspaceSourceBoundary: context.workspaceSourceBoundary.identity,
  });
  return `project-dependencies:${createHash('sha256')
    .update(canonicalIdentity)
    .digest('hex')}`;
}

export function getProjectSemanticCacheIdentity(
  request: ProjectDependencyRequest,
): string {
  return (
    request.projectSemanticCacheIdentity ??
    createProjectSemanticCacheIdentity(request.context)
  );
}
