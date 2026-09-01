import {
  type AstroSemanticProject,
  createAstroSemanticProject,
} from '#checkers';
import { normalizeAbsolutePath } from '#utils/path';
import ts from 'typescript';
import type { AutoScopeProject } from '../build-graph/auto-checker-types';
import type { LockedSemanticAuthority } from '../build-graph/checker-ownership-types';
import type { GovernedSourceUnit, SourceProject } from '../build-graph/types';
import type { ProjectInfo } from '../import-graph/project-types';
import { createSvelteSemanticProject } from '../svelte-semantic/project';
import type { SvelteSemanticProject } from '../svelte-semantic/types';
import type { WorkspaceSourceBoundary } from '../typescript-semantic';
import { parseTypeScriptProjectConfig } from '../typescript-semantic/project-references';
import type { ProjectSemanticContext } from './contracts';

interface SemanticContextProject {
  analysisGeneration: number;
  astroSemanticProject?: AstroSemanticProject;
  configPath: string;
  extensions: readonly string[];
  fileNames: readonly string[];
  options: ts.CompilerOptions;
  packageRootByFileName: ReadonlyMap<string, string>;
  packageRootDir: string;
  references: readonly ts.ProjectReference[];
  resolverConfigPath: string;
  svelteSemanticProject?: SvelteSemanticProject;
  vueSemanticIdentity?: ProjectSemanticContext['vueSemanticIdentity'];
  workspaceSourceBoundary: WorkspaceSourceBoundary;
}

function createContext(options: {
  authority: LockedSemanticAuthority;
  project: SemanticContextProject;
}): ProjectSemanticContext {
  return {
    astroSemanticProject: options.project.astroSemanticProject,
    compilerOptions: options.project.options,
    configPath: normalizeAbsolutePath(options.project.configPath),
    extensions: [...options.project.extensions],
    fileNames: options.project.fileNames.map(normalizeAbsolutePath),
    generation: options.project.analysisGeneration,
    packageRootByFileName: new Map(options.project.packageRootByFileName),
    packageRootDir: normalizeAbsolutePath(options.project.packageRootDir),
    references: options.project.references.map((reference) => ({
      ...reference,
    })),
    resolverConfigPath: normalizeAbsolutePath(
      options.project.resolverConfigPath,
    ),
    semanticAuthority: { ...options.authority },
    svelteSemanticProject: options.project.svelteSemanticProject,
    vueSemanticIdentity: options.project.vueSemanticIdentity,
    workspaceSourceBoundary: options.project.workspaceSourceBoundary,
  };
}

function packageRootsForFiles(
  fileNames: readonly string[],
  packageRootDir: string,
): Map<string, string> {
  return new Map(
    fileNames.map((fileName) => [
      normalizeAbsolutePath(fileName),
      packageRootDir,
    ]),
  );
}

function getSourceAnalysisGeneration(project: SourceProject): number {
  return project.context.vueSemanticIdentity?.generation ?? 0;
}

function getSourceAstroProject(
  source: GovernedSourceUnit | undefined,
): AstroSemanticProject | undefined {
  return source?.astroSemanticProject;
}

function getSourceSvelteProject(
  source: GovernedSourceUnit | undefined,
): SvelteSemanticProject | undefined {
  return source?.svelteSemanticProject;
}

function getRawProjectReferences(
  configPath: string,
): readonly ts.ProjectReference[] {
  return (
    parseTypeScriptProjectConfig({ configPath, tsModule: ts })
      ?.projectReferences ?? []
  );
}

export function createAutoProjectSemanticContext(options: {
  authority: LockedSemanticAuthority;
  project: AutoScopeProject;
  workspaceSourceBoundary: WorkspaceSourceBoundary;
}): ProjectSemanticContext {
  return createContext({
    authority: options.authority,
    project: {
      analysisGeneration: options.project.analysisGeneration,
      astroSemanticProject:
        options.authority.family === 'astro'
          ? createAstroSemanticProject({
              analysisGeneration: options.project.analysisGeneration,
              configPath: options.project.configPath,
              packageRootDir: options.project.packageRootDir,
              projectFingerprint: options.project.configPath,
              readSnapshot: () => ({
                checkerExtensions: options.project.context.extensions,
                compilerOptions: options.project.options,
                configClosure: options.project.configClosure,
                fileNames: options.project.fileNames,
                projectReferences: options.project.references,
              }),
            })
          : undefined,
      configPath: options.project.configPath,
      extensions: options.project.context.extensions,
      fileNames: options.project.fileNames,
      options: options.project.options,
      packageRootByFileName: options.project.packageRootByFileName,
      packageRootDir: options.project.packageRootDir,
      references: options.project.references,
      resolverConfigPath: options.project.configPath,
      svelteSemanticProject:
        options.authority.family === 'svelte'
          ? createSvelteSemanticProject({
              configPath: options.project.configPath,
              extensions: options.project.context.extensions,
              fileNames: options.project.fileNames,
              generation: options.project.analysisGeneration,
              options: options.project.options,
              packageRootDir: options.project.packageRootDir,
            })
          : undefined,
      vueSemanticIdentity: options.project.context.vueSemanticIdentity,
      workspaceSourceBoundary: options.workspaceSourceBoundary,
    },
  });
}

export function createSourceProjectSemanticContext(options: {
  authority: LockedSemanticAuthority;
  project: SourceProject;
  source?: GovernedSourceUnit;
  workspaceSourceBoundary: WorkspaceSourceBoundary;
}): ProjectSemanticContext {
  return createContext({
    authority: options.authority,
    project: {
      analysisGeneration: getSourceAnalysisGeneration(options.project),
      astroSemanticProject: getSourceAstroProject(options.source),
      configPath: options.project.configPath,
      extensions: options.project.context.extensions,
      fileNames: options.project.ownedFileNames,
      options: options.project.options,
      packageRootByFileName: packageRootsForFiles(
        options.project.ownedFileNames,
        options.project.packageRootDir,
      ),
      packageRootDir: options.project.packageRootDir,
      references: getRawProjectReferences(options.project.configPath),
      resolverConfigPath: options.project.configPath,
      svelteSemanticProject: getSourceSvelteProject(options.source),
      vueSemanticIdentity: options.project.context.vueSemanticIdentity,
      workspaceSourceBoundary: options.workspaceSourceBoundary,
    },
  });
}

export function createParsedProjectSemanticContext(options: {
  authority: LockedSemanticAuthority;
  packageRootDir: string;
  project: ProjectInfo;
  workspaceSourceBoundary: WorkspaceSourceBoundary;
}): ProjectSemanticContext {
  return createContext({
    authority: options.authority,
    project: {
      analysisGeneration: options.project.analysisGeneration,
      astroSemanticProject: options.project.astroSemanticProject,
      configPath: options.project.configPath,
      extensions: options.project.extensions,
      fileNames: options.project.ownedFileNames,
      options: options.project.options,
      packageRootByFileName: packageRootsForFiles(
        options.project.ownedFileNames,
        options.packageRootDir,
      ),
      packageRootDir: options.packageRootDir,
      references: getRawProjectReferences(options.project.resolverConfigPath),
      resolverConfigPath: options.project.resolverConfigPath,
      svelteSemanticProject: options.project.svelteSemanticProject,
      vueSemanticIdentity: options.project.vueSemanticIdentity,
      workspaceSourceBoundary: options.workspaceSourceBoundary,
    },
  });
}
