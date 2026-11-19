import {
  type CheckerProjectConfigCache,
  isNativeTypeScriptProjectInput,
  parseCheckerProjectConfigForContext,
} from '#checkers';
import { compareCodeUnits } from '#utils/collections';
import type { AutoScopeProject } from './auto-checker-types';
import type { LockedSemanticAuthority } from './checker-ownership-types';
import { getScopedParseContext } from './explicit-checker-project-helpers';
import { partitionSourceFiles } from './source-capabilities';

export interface FrozenSemanticProject {
  readonly authority: LockedSemanticAuthority;
  readonly project: AutoScopeProject;
}

export function freezeSemanticProject(
  input: Parameters<typeof prepareLockedSemanticProject>[0],
): FrozenSemanticProject {
  return {
    authority: { ...input.authority },
    project: prepareLockedSemanticProject(input),
  };
}

/**
Parse the execution inputs for the family selected by config ownership.
*/
export function prepareLockedSemanticProject(input: {
  project: AutoScopeProject;
  authority: LockedSemanticAuthority;
  projectConfigCache?: CheckerProjectConfigCache;
  rootDir: string;
}): AutoScopeProject {
  const parseContext = getScopedParseContext(
    (
      {
        typescript: 'tsc',
        vue: 'vue-tsc',
        astro: 'astro',
        svelte: 'svelte-check',
      } as const
    )[input.authority.family],
  );
  const parsed = parseCheckerProjectConfigForContext({
    allowNoInputDiagnostics: true,
    cache: input.projectConfigCache,
    configPath: input.project.configPath,
    context: parseContext,
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
  const filePartition = partitionSourceFiles(parsed.fileNames);
  if (parsed.vueSemanticIdentity)
    filePartition.vueFiles = [
      ...new Set([
        ...filePartition.vueFiles,
        ...parsed.vueSemanticIdentity.profilesByFileName.keys(),
      ]),
    ].sort(compareCodeUnits);
  return {
    ...input.project,
    filePartition,
    configClosure: parsed.configClosure.map((entry) => ({ ...entry })),
    options: parsed.options,
    references: parsed.projectReferences ?? [],
    fileNames: [...parsed.fileNames],
    context: {
      checkerPresets: [...parseContext.checkerPresets],
      extensions: [...parsed.extensions],
      vueSemanticIdentity: parsed.vueSemanticIdentity,
    },
  };
}
