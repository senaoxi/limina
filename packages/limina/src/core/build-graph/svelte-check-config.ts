import { isPathInsideDirectory, normalizeAbsolutePath } from '#utils/path';
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
  sourceCheckRoot?: string;
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

function declarationRootDirectories(input: SvelteCheckConfigInput): string[] {
  const roots = [...(input.options.rootDirs ?? []), ...input.declarationRoots];
  return [
    ...new Set(
      roots.flatMap((root) => {
        if (!/^[A-Za-z]:\//u.test(root)) return [root];
        // Svelte's URI paths lowercase drive letters, while TypeScript matches
        // rootDirs prefixes case-sensitively even with a case-insensitive Host.
        // Both spellings name the same drive; directory spelling stays intact.
        const drive = root.charAt(0);
        const alias =
          drive === drive.toLowerCase()
            ? drive.toUpperCase()
            : drive.toLowerCase();
        return [root, `${alias}${root.slice(1)}`];
      }),
    ),
  ];
}

function sourceCheckOptions(input: SvelteCheckConfigInput): ts.CompilerOptions {
  const root = input.sourceCheckRoot;
  if (root === undefined) return {};
  const source = input.options;
  return {
    rootDir:
      source.rootDir !== undefined &&
      isPathInsideDirectory(root, source.rootDir)
        ? source.rootDir
        : root,
    ...(source.composite === true && {
      composite: false,
      declaration: source.declaration ?? true,
      incremental: source.incremental ?? true,
    }),
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
      ...sourceCheckOptions(input),
      disableSourceOfProjectReferenceRedirect: false,
      rootDirs: declarationRootDirectories(input),
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
