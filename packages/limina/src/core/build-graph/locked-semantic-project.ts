import {
  type CheckerProjectConfigCache,
  isNativeTypeScriptProjectInput,
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
  if (
    input.authority.family !== 'vue' &&
    input.authority.family !== 'typescript'
  )
    return input.project;
  const checker = input.authority.family === 'vue' ? 'vue-tsc' : 'tsc';
  const parsed = parseCheckerProjectConfigForContext({
    allowNoInputDiagnostics: true,
    cache: input.projectConfigCache,
    configPath: input.project.configPath,
    context: { checkerPresets: [checker], extensions: [] },
    projectRootDir: input.rootDir,
    virtualFiles: input.project.virtualFiles,
  });
  if (
    input.authority.family === 'typescript' &&
    parsed.fileNames.some((file) => !isNativeTypeScriptProjectInput(file))
  ) {
    throw new Error(
      `Native TypeScript cannot compile an explicitly selected root in ${input.project.configPath}.`,
    );
  }
  return {
    ...input.project,
    configClosure: parsed.configClosure,
    options: parsed.options,
    fileNames: parsed.fileNames,
    context: {
      checkerPresets: [checker],
      extensions: parsed.extensions,
      vueSemanticIdentity: parsed.vueSemanticIdentity,
    },
  };
}
