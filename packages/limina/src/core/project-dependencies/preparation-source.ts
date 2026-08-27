import { createAstroSemanticProject, resolveVueSourceProfile } from '#checkers';
import { normalizeAbsolutePath } from '#utils/path';
import { createSvelteSemanticProject } from '../svelte-semantic/project';
import { createProjectSemanticCacheIdentity } from './cache';
import type {
  ProjectDependencyCollection,
  ProjectDependencyRequest,
  SourceEvidence,
} from './contracts';
import { createProjectDependencyFailure } from './failure';
import { collectSourceEvidence } from './source-evidence';

export interface FilePreparationOptions {
  collection: ProjectDependencyCollection;
  fileName: string;
  request: ProjectDependencyRequest;
}

function getPackageRoot(
  request: ProjectDependencyRequest,
  fileName: string,
): string {
  return (
    request.context.packageRootByFileName.get(
      normalizeAbsolutePath(fileName),
    ) ?? request.context.packageRootDir
  );
}

function getAstroProjectForRoot(options: {
  packageRootDir: string;
  request: ProjectDependencyRequest;
}) {
  const project = options.request.context.astroSemanticProject;
  if (project === undefined) return project;
  if (project.seed.packageRootDir === options.packageRootDir) return project;
  return createAstroSemanticProject({
    analysisGeneration: project.seed.analysisGeneration,
    configPath: project.seed.configPath,
    overlayGeneration: project.seed.overlayGeneration,
    packageRootDir: options.packageRootDir,
    projectFingerprint: `${project.seed.projectFingerprint}:${options.packageRootDir}`,
    readSnapshot: project.readSnapshot,
  });
}

function getSvelteProjectForRoot(options: {
  packageRootDir: string;
  request: ProjectDependencyRequest;
}) {
  const project = options.request.context.svelteSemanticProject;
  if (project === undefined) return project;
  if (project.packageRootDir === options.packageRootDir) return project;
  return createSvelteSemanticProject({
    configPath: project.configPath,
    extensions: project.extensions,
    fileNames: project.fileNames,
    generation: project.generation,
    options: project.options,
    packageRootDir: options.packageRootDir,
    resolverConfigPath: project.resolverConfigPath,
  });
}

export function createFileRequest(
  request: ProjectDependencyRequest,
  fileName: string,
): ProjectDependencyRequest {
  const packageRootDir = getPackageRoot(request, fileName);
  const options = { packageRootDir, request };
  return {
    ...request,
    context: {
      ...request.context,
      astroSemanticProject: getAstroProjectForRoot(options),
      packageRootDir,
      svelteSemanticProject: getSvelteProjectForRoot(options),
    },
  };
}

function addSourceDiagnostics(options: {
  base: FilePreparationOptions;
  diagnostics: readonly string[];
}): void {
  for (const diagnostic of options.diagnostics) {
    options.base.collection.failures.push(
      createProjectDependencyFailure({
        identity: JSON.stringify({
          configPath: options.base.request.context.configPath,
          filePath: normalizeAbsolutePath(options.base.fileName),
          framework: options.base.request.context.semanticAuthority.family,
          stage: 'dependency-enumeration',
        }),
        reason: diagnostic,
        request: options.base.request,
        stage: 'dependency-enumeration',
      }),
    );
  }
}

export function collectFileSourceEvidence(
  options: FilePreparationOptions,
): SourceEvidence {
  const { request } = options;
  const source = collectSourceEvidence({
    cache: request.caches?.sourceEvidenceCache,
    cacheIdentity: createProjectSemanticCacheIdentity(request.context),
    filePath: options.fileName,
    importAnalysis: request.importAnalysis,
    packageRootDir: request.context.packageRootDir,
    semanticFamily: request.context.semanticAuthority.family,
    sourceProfile: resolveVueSourceProfile({
      fileName: options.fileName,
      identity: request.context.vueSemanticIdentity,
    }),
  });
  addSourceDiagnostics({ base: options, diagnostics: source.diagnostics });
  return source;
}

function requiresAstroPreparation(fileName: string): boolean {
  const normalized = fileName.toLowerCase();
  return ['.astro', '.svelte', '.vue'].some((extension) =>
    normalized.endsWith(extension),
  );
}

function requiresSveltePreparation(fileName: string): boolean {
  return fileName.toLowerCase().endsWith('.svelte');
}

function requiresVuePreparation(options: FilePreparationOptions): boolean {
  return (
    resolveVueSourceProfile({
      fileName: options.fileName,
      identity: options.request.context.vueSemanticIdentity,
    }) !== undefined
  );
}

const GENERATED_PREPARATION_REQUIREMENTS = {
  astro: (options: FilePreparationOptions) =>
    requiresAstroPreparation(options.fileName),
  svelte: (options: FilePreparationOptions) =>
    requiresSveltePreparation(options.fileName),
  typescript: () => false,
  vue: requiresVuePreparation,
} as const;

export function requiresGeneratedSemanticPreparation(
  options: FilePreparationOptions,
): boolean {
  const family = options.request.context.semanticAuthority.family;
  return GENERATED_PREPARATION_REQUIREMENTS[family](options);
}
