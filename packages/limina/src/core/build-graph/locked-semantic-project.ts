import {
  type CheckerProjectConfigCache,
  type CheckerProjectParseContext,
  isNativeTypeScriptProjectInput,
  parseCheckerProjectConfigForContext,
  type ParsedCheckerProjectConfig,
} from '#checkers';
import type { ResolvedLiminaInputs } from '#config/runner';
import { uniqueCodeUnitSortedStrings } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { currentProfile } from '../../application/analysis/observability';
import { createProjectParseHost } from '../../checker/project-base';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import { observeWork } from '../analysis-profile';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import type {
  AutoScopeProject,
  SourceConfigCandidate,
} from './auto-checker-types';
import type { LockedSemanticAuthority } from './checker-ownership-types';
import { getScopedParseContext } from './explicit-checker-project-helpers';
import { bindVueSourceConfig } from './framework-source-authority';

export interface FrozenSemanticProject {
  readonly authority: LockedSemanticAuthority;
  readonly project: AutoScopeProject;
}

interface ProjectInput {
  activatedRegions: WorkspaceRegionPathIndex;
  candidate: SourceConfigCandidate;
  config: ResolvedLiminaInputs;
  projectConfigCache?: CheckerProjectConfigCache;
}

function readProjectConfig(
  input: ProjectInput,
  context: CheckerProjectParseContext,
): ParsedCheckerProjectConfig {
  return parseCheckerProjectConfigForContext({
    allowNoInputDiagnostics: true,
    cache: input.projectConfigCache,
    configPath: input.candidate.configPath,
    context,
    projectRootDir: input.config.rootDir,
    virtualFiles: input.config.virtualFiles,
  });
}

function buildProject(
  input: ProjectInput,
  parsed: ParsedCheckerProjectConfig,
  context: CheckerProjectParseContext,
): AutoScopeProject {
  const { configObject, configPath, packageRootDir } = input.candidate;
  return {
    analysisGeneration: input.projectConfigCache?.generation ?? 0,
    configPath,
    packageRootDir,
    virtualFiles: input.config.virtualFiles,
    svelteOptions: configObject.svelteOptions,
    configClosure: parsed.configClosure,
    options: parsed.options,
    references: parsed.projectReferences ?? [],
    fileNames: parsed.fileNames,
    packageRootByFileName: new Map(
      parsed.fileNames.map((file) => [
        file,
        input.activatedRegions.findPackageForPath(file)?.directory ??
          packageRootDir,
      ]),
    ),
    context: {
      checkerPresets: context.checkerPresets,
      extensions: parsed.extensions,
      vueSemanticIdentity: parsed.vueSemanticIdentity,
    },
  };
}

function coverageFileNames(
  input: ProjectInput & { includeFrameworkCandidates: boolean },
  parsed: ParsedCheckerProjectConfig,
): string[] {
  if (!input.includeFrameworkCandidates) return parsed.fileNames;
  const alreadySelected = new Set(parsed.extensions);
  const extensions = [
    '.astro',
    '.svelte',
    '.vue',
    ...(parsed.configuredVueExtensions ?? []),
  ].filter((extension) => !alreadySelected.has(extension));
  if (extensions.length === 0) return parsed.fileNames;
  const host = createProjectParseHost(input.config.virtualFiles);
  const selectors = parsed.rootSelectors ?? [];
  const observer = selectors.length > 0 ? currentProfile() : undefined;
  const additional = observeWork(
    observer,
    'source-config.framework-coverage-enumeration',
    () =>
      selectors.flatMap(([root, , excludes, includes, depth]) =>
        host.readDirectory(root, extensions, excludes, includes, depth),
      ),
    observer === undefined
      ? undefined
      : ['project', observer.project(input.candidate.configPath)],
  );
  return uniqueCodeUnitSortedStrings([
    ...parsed.fileNames,
    ...additional.map(normalizeAbsolutePath),
  ]);
}

export function freezeSemanticProject(
  input: ProjectInput & {
    authority: LockedSemanticAuthority;
    cache?: NativeAnalysisCache;
    includeFrameworkCandidates: boolean;
  },
): { frozen: FrozenSemanticProject; members: string[] } {
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
  const cache = input.cache;
  if (cache !== undefined && input.authority.family === 'vue')
    parseContext.bindVueSourceConfig = (toolchain) =>
      bindVueSourceConfig(
        cache,
        input.candidate.configPath,
        input.authority.source,
        toolchain,
      );
  const observer = currentProfile();
  const parsed = observeWork(
    observer,
    'source-config.authorized-read',
    () => readProjectConfig(input, parseContext),
    observer === undefined
      ? undefined
      : ['project', observer.project(input.candidate.configPath)],
  );
  if (
    input.authority.family === 'typescript' &&
    parsed.fileNames.some((file) => !isNativeTypeScriptProjectInput(file))
  ) {
    throw new Error(
      `Native TypeScript cannot compile an explicitly selected root in ${input.candidate.configPath}.`,
    );
  }
  return {
    frozen: {
      authority: { ...input.authority },
      project: buildProject(input, parsed, parseContext),
    },
    members: coverageFileNames(input, parsed),
  };
}

export function prepareDiagnosticNativeProject(
  input: ProjectInput & { includeFrameworkCandidates: boolean },
): { project: AutoScopeProject; members: string[] } {
  const context = getScopedParseContext('tsc');
  const parsed = readProjectConfig(input, context);
  return {
    project: buildProject(input, parsed, context),
    members: coverageFileNames(input, parsed),
  };
}
