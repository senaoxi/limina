import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import type ts from 'typescript';
import { absoluteCompilerPaths } from '../typescript-semantic/compiler-options';
import { createRelativePath } from './generated/paths';

export interface SvelteCheckConfigInput {
  sourceConfigPath: string;
  checkConfigPath: string;
  fileNames: readonly string[];
  options: ts.CompilerOptions;
  references: readonly string[];
  declarationRoots: readonly string[];
  svelteOptions?: unknown;
}

export function svelteCheckConfigPath(sourceConfig: string): string {
  return normalizeAbsolutePath(
    path.join(
      path.dirname(sourceConfig),
      '.limina',
      'check',
      path.basename(sourceConfig).replace(/\.json$/u, '.check.json'),
    ),
  );
}

/**
Pin defaults at their original compiler context, not the generated path.
*/
function sourcePathOptions(
  input: SvelteCheckConfigInput,
): Record<string, unknown> {
  const source = input.options;
  const sourceRootDirectory =
    source.rootDir ??
    (source.composite ? path.dirname(input.sourceConfigPath) : undefined);
  return {
    ...(sourceRootDirectory !== undefined && { rootDir: sourceRootDirectory }),
    ...(source.outDir !== undefined && { outDir: source.outDir }),
    ...(source.declarationDir !== undefined && {
      declarationDir: source.declarationDir,
    }),
    ...(source.outFile !== undefined && { outFile: source.outFile }),
    ...(source.tsBuildInfoFile !== undefined && {
      tsBuildInfoFile: source.tsBuildInfoFile,
    }),
    ...(source.baseUrl !== undefined && { baseUrl: source.baseUrl }),
    ...(source.paths !== undefined && { paths: absoluteCompilerPaths(source) }),
    ...(source.typeRoots !== undefined && { typeRoots: source.typeRoots }),
  };
}

export function createSvelteCheckConfig(
  input: SvelteCheckConfigInput,
): Record<string, unknown> {
  return {
    extends: createRelativePath(input.checkConfigPath, input.sourceConfigPath),
    files: input.fileNames.map((file) =>
      createRelativePath(input.checkConfigPath, file),
    ),
    include: [],
    compilerOptions: {
      ...sourcePathOptions(input),
      disableSourceOfProjectReferenceRedirect: false,
      rootDirs: [
        ...new Set([
          ...(input.options.rootDirs ?? []),
          ...input.declarationRoots,
        ]),
      ],
    },
    references: input.references.map((reference) => ({
      path: createRelativePath(input.checkConfigPath, reference),
    })),
    ...(input.svelteOptions !== undefined && {
      svelteOptions: input.svelteOptions,
    }),
    liminaOptions: {
      generated: true,
      checker: 'svelte-check',
      sourceConfig: createRelativePath(
        input.checkConfigPath,
        input.sourceConfigPath,
      ),
    },
  };
}
