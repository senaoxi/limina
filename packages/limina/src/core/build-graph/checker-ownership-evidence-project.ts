import {
  type CheckerProjectConfigCache,
  type CheckerProjectParseContext,
  getBuildCheckerSupportedExtensions,
  parseCheckerProjectConfigForContext,
} from '#checkers';
import type { CheckerName } from '#config/runner';
import type ts from 'typescript';
import { createAutoProjectSemanticContext } from '../project-dependencies/context';
import type { ProjectSemanticContext } from '../project-dependencies/contracts';
import type { AutoScopeProject } from './auto-checker-types';
import type {
  SemanticFamily,
  TypeConfigOwnershipState,
} from './checker-ownership-types';

export interface EvidenceProject {
  checkerName: CheckerName;
  project: {
    checkerPresets: CheckerProjectParseContext['checkerPresets'];
    configPath: string;
    extensions: string[];
    fileNames: string[];
    options: AutoScopeProject['options'];
    projectReferences: readonly ts.ProjectReference[];
    resolverConfigPath: string;
    semanticFamily: SemanticFamily;
    astroSemanticProject?: ProjectSemanticContext['astroSemanticProject'];
    svelteSemanticProject?: ProjectSemanticContext['svelteSemanticProject'];
    vueSemanticIdentity?: CheckerProjectParseContext['vueSemanticIdentity'];
  };
}

function getEvidenceChecker(state: TypeConfigOwnershipState): CheckerName {
  if (state.semanticAuthority.kind === 'pending') return 'tsc';
  return getLockedEvidenceChecker(
    state.semanticAuthority,
    state.authoritativeOwner,
  );
}

function getLockedEvidenceChecker(
  authority: Extract<
    TypeConfigOwnershipState['semanticAuthority'],
    { kind: 'locked' }
  >,
  authoritativeOwner: CheckerName | undefined,
): CheckerName {
  if (authority.family === 'vue') return 'vue-tsc';
  return getTypeScriptEvidenceChecker(authoritativeOwner);
}

function getTypeScriptEvidenceChecker(
  authoritativeOwner: CheckerName | undefined,
): CheckerName {
  return authoritativeOwner === 'tsgo' ? 'tsgo' : 'tsc';
}

function createDefaultParseContext(
  checkerName: CheckerName,
): CheckerProjectParseContext {
  if (checkerName === 'tsc' || checkerName === 'tsgo') {
    return {
      checkerPresets: [checkerName],
      extensions: [],
    };
  }
  return { checkerPresets: [checkerName], extensions: [] };
}

function createParseContext(
  checkerName: CheckerName,
  project: AutoScopeProject,
  state: TypeConfigOwnershipState,
): CheckerProjectParseContext {
  if (state.semanticAuthority.kind === 'locked') {
    return {
      checkerPresets: [checkerName],
      extensions: [...project.context.extensions],
      vueSemanticIdentity: project.context.vueSemanticIdentity,
    };
  }
  return createDefaultParseContext(checkerName);
}

function getSemanticExtensions(
  checkerName: CheckerName,
  project: AutoScopeProject,
  state: TypeConfigOwnershipState,
): string[] {
  if (
    state.semanticAuthority.kind === 'locked' &&
    state.semanticAuthority.family !== 'typescript'
  ) {
    return [...project.context.extensions];
  }
  return getBuildCheckerSupportedExtensions(checkerName);
}

function getEvidenceSemanticFamily(
  state: TypeConfigOwnershipState,
): SemanticFamily {
  return state.semanticAuthority.kind === 'locked'
    ? state.semanticAuthority.family
    : 'typescript';
}

function createEvidenceSemanticContext(options: {
  project: AutoScopeProject;
  state: TypeConfigOwnershipState;
}): ProjectSemanticContext | undefined {
  if (options.state.semanticAuthority.kind !== 'locked') return undefined;
  return createAutoProjectSemanticContext({
    authority: options.state.semanticAuthority,
    project: options.project,
  });
}

function getAstroSemanticProject(
  context: ProjectSemanticContext | undefined,
): ProjectSemanticContext['astroSemanticProject'] {
  return context?.astroSemanticProject;
}

function getSvelteSemanticProject(
  context: ProjectSemanticContext | undefined,
): ProjectSemanticContext['svelteSemanticProject'] {
  return context?.svelteSemanticProject;
}

function getVueSemanticIdentity(options: {
  context: CheckerProjectParseContext;
  parsed: ReturnType<typeof parseCheckerProjectConfigForContext>;
}) {
  return (
    options.context.vueSemanticIdentity ?? options.parsed.vueSemanticIdentity
  );
}

export function createEvidenceProject(options: {
  project: AutoScopeProject;
  projectConfigCache?: CheckerProjectConfigCache;
  rootDir: string;
  state: TypeConfigOwnershipState;
}): EvidenceProject {
  const checkerName = getEvidenceChecker(options.state);
  const context = createParseContext(
    checkerName,
    options.project,
    options.state,
  );
  const parsed = parseCheckerProjectConfigForContext({
    allowNoInputDiagnostics: true,
    cache: options.projectConfigCache,
    configPath: options.project.configPath,
    context,
    projectRootDir: options.rootDir,
  });
  const semanticFamily = getEvidenceSemanticFamily(options.state);
  const semanticContext = createEvidenceSemanticContext(options);
  return {
    checkerName,
    project: {
      checkerPresets: [checkerName],
      astroSemanticProject: getAstroSemanticProject(semanticContext),
      configPath: options.project.configPath,
      extensions: [
        ...getSemanticExtensions(checkerName, options.project, options.state),
      ],
      fileNames: [...parsed.fileNames],
      options: parsed.options,
      projectReferences: options.project.references,
      resolverConfigPath: options.project.configPath,
      semanticFamily,
      svelteSemanticProject: getSvelteSemanticProject(semanticContext),
      vueSemanticIdentity: getVueSemanticIdentity({ context, parsed }),
    },
  };
}
