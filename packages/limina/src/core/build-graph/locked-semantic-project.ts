import {
  type CheckerProjectConfigCache,
  parseCheckerProjectConfigForContext,
} from '#checkers';
import type { AutoScopeProject } from './auto-checker-types';
import type { LockedSemanticAuthority } from './checker-ownership-types';

/**
Selection can discover Vue through a dependency of an otherwise Native project.
The locked producer needs its own parsed identity, not the pending TS context.
*/
export function prepareLockedSemanticProject(input: {
  project: AutoScopeProject;
  authority: LockedSemanticAuthority;
  projectConfigCache?: CheckerProjectConfigCache;
  rootDir: string;
}): AutoScopeProject {
  if (input.authority.family !== 'vue') return input.project;
  const parsed = parseCheckerProjectConfigForContext({
    allowNoInputDiagnostics: true,
    cache: input.projectConfigCache,
    configPath: input.project.configPath,
    context: { checkerPresets: ['vue-tsc'], extensions: [] },
    projectRootDir: input.rootDir,
    virtualFiles: input.project.virtualFiles,
  });
  return {
    ...input.project,
    configClosure: parsed.configClosure,
    options: parsed.options,
    fileNames: parsed.fileNames,
    context: {
      checkerPresets: ['vue-tsc'],
      extensions: parsed.extensions,
      vueSemanticIdentity: parsed.vueSemanticIdentity,
    },
  };
}
