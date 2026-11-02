import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  createSvelteCheckConfig,
  svelteCheckConfigPath,
} from '../core/build-graph/svelte-check-config';
import { createFixturePathResolver, toPortablePath } from './helpers/path';

function parse(config: string): ts.ParsedCommandLine {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    config,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (error) => {
        throw new Error(
          ts.flattenDiagnosticMessageText(error.messageText, '\n'),
        );
      },
    },
  );
  if (parsed === undefined) throw new Error(`Unable to parse ${config}`);
  expect(parsed.errors).toEqual([]);
  return parsed;
}

describe('Svelte check project reference output identity', () => {
  it.each([
    { sourceDrive: 'C:', importerDrive: 'c:' },
    { sourceDrive: 'c:', importerDrive: 'C:' },
    { sourceDrive: 'C:', importerDrive: 'C:' },
    { sourceDrive: 'c:', importerDrive: 'c:' },
  ])(
    'resolves declaration mirrors from $importerDrive with $sourceDrive configuration paths',
    ({ sourceDrive, importerDrive }) => {
      const root = `${sourceDrive}/Workspace/Project`;
      const mirror = `${root}/.limina/declarations/svelte`;
      const declaration = `${mirror}/b/b.vue.d.ts`;
      const files = new Map([
        [
          declaration.toLowerCase(),
          'declare const component: unknown; export default component;',
        ],
      ]);
      const projected = createSvelteCheckConfig({
        sourceConfigPath: `${root}/tsconfig.a.json`,
        checkConfigPath: `${root}/.limina/check/tsconfig.a.check.json`,
        fileNames: [`${root}/a/a.svelte`],
        options: {},
        references: [],
        declarationRoots: [root, mirror],
      });
      const host: ts.ModuleResolutionHost = {
        directoryExists: () => true,
        fileExists: (file) => files.has(file.toLowerCase()),
        readFile: (file) => files.get(file.toLowerCase()),
        useCaseSensitiveFileNames: false,
      };
      const resolve = (importer: string) =>
        ts.resolveModuleName(
          '../b/b.vue',
          importer,
          {
            moduleResolution: ts.ModuleResolutionKind.Bundler,
            rootDirs: (projected.compilerOptions as ts.CompilerOptions)
              .rootDirs,
          },
          host,
        ).resolvedModule?.resolvedFileName;
      expect(resolve(`${importerDrive}/Workspace/Project/a/a.svelte.ts`)).toBe(
        declaration,
      );
      expect(
        resolve(`${importerDrive}/Workspace/Other/a/a.svelte.ts`),
      ).toBeUndefined();
    },
  );

  it('preserves case-sensitive POSIX declaration roots', () => {
    const root = '/Workspace/Project';
    const mirror = `${root}/.limina/declarations/svelte`;
    const declaration = `${mirror}/b/b.vue.d.ts`;
    const files = new Map([
      [
        declaration,
        'declare const component: unknown; export default component;',
      ],
    ]);
    const projected = createSvelteCheckConfig({
      sourceConfigPath: `${root}/tsconfig.a.json`,
      checkConfigPath: `${root}/.limina/check/tsconfig.a.check.json`,
      fileNames: [`${root}/a/a.svelte`],
      options: {},
      references: [],
      declarationRoots: [root, mirror],
    });
    const resolve = (importer: string) =>
      ts.resolveModuleName(
        '../b/b.vue',
        importer,
        {
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          rootDirs: (projected.compilerOptions as ts.CompilerOptions).rootDirs,
        },
        {
          directoryExists: () => true,
          fileExists: (file) => files.has(file),
          readFile: (file) => files.get(file),
          useCaseSensitiveFileNames: true,
        },
      ).resolvedModule?.resolvedFileName;
    expect(resolve(`${root}/a/a.svelte.ts`)).toBe(declaration);
    expect(resolve('/workspace/Project/a/a.svelte.ts')).toBeUndefined();
  });

  it.each([
    {
      name: 'implicit composite root with outDir',
      options: { outDir: './dist' },
      output: 'project/dist/src/value.d.ts',
    },
    {
      name: 'explicit root with outDir',
      options: { rootDir: './src', outDir: './dist' },
      output: 'project/dist/value.d.ts',
    },
    {
      name: 'implicit root with declarationDir',
      options: { outDir: './js', declarationDir: './types' },
      output: 'project/types/src/value.d.ts',
    },
    {
      name: 'explicit root with separate declarationDir',
      options: { rootDir: './src', outDir: './js', declarationDir: './types' },
      output: 'project/types/value.d.ts',
    },
    {
      name: 'inherited configDir root and output directories',
      options: {},
      inherited: {
        rootDir: '${configDir}/src',
        outDir: '${configDir}/js',
        declarationDir: '${configDir}/types',
      },
      output: 'project/types/value.d.ts',
    },
    {
      name: 'implicit root with adjacent declaration',
      options: {},
      output: 'project/src/value.d.ts',
    },
  ])('$name', async ({ options, output, inherited }) => {
    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), 'limina-check-mapping-'),
    );
    const rootDirectory = realpathSync.native(temporaryDirectory);
    const file = createFixturePathResolver(rootDirectory);
    const write = async (name: string, text: string) => {
      await mkdir(path.dirname(file(name)), { recursive: true });
      await writeFile(file(name), text);
    };
    try {
      await write('project/src/value.ts', 'export const value = 1;');
      if (inherited !== undefined)
        await write(
          'base.json',
          JSON.stringify({ compilerOptions: inherited }),
        );
      await write(
        'project/tsconfig.json',
        JSON.stringify({
          ...(inherited !== undefined && { extends: '../base.json' }),
          compilerOptions: {
            composite: true,
            declaration: true,
            noLib: true,
            types: [],
            ...options,
          },
          include: ['src/**/*.ts'],
        }),
      );
      const original = parse(file('project/tsconfig.json'));
      const checkPath = svelteCheckConfigPath(file('project/tsconfig.json'));
      const projected = createSvelteCheckConfig({
        sourceConfigPath: file('project/tsconfig.json'),
        checkConfigPath: checkPath,
        fileNames: original.fileNames,
        options: original.options,
        references: [],
        declarationRoots: [],
      });
      await mkdir(path.dirname(checkPath), { recursive: true });
      await writeFile(checkPath, JSON.stringify(projected));
      const check = parse(checkPath);
      const declarations = (parsed: ts.ParsedCommandLine) =>
        ts
          .getOutputFileNames(
            parsed,
            file('project/src/value.ts'),
            !ts.sys.useCaseSensitiveFileNames,
          )
          .filter((name) => name.endsWith('.d.ts'))
          .map(toPortablePath);
      expect(declarations(original)).toEqual([file(output)]);
      expect(declarations(check)).toEqual([file(output)]);
      await write(output, 'export declare const value: 1;');
      await write(
        'consumer.ts',
        'import { value } from "./project/src/value"; export const result = value;',
      );
      for (const reference of [file('project/tsconfig.json'), checkPath]) {
        const program = ts.createProgram({
          rootNames: [file('consumer.ts')],
          options: { noLib: true, types: [], module: ts.ModuleKind.CommonJS },
          projectReferences: [{ path: reference }],
        });
        expect(
          program
            .getSourceFiles()
            .map((source) => toPortablePath(source.fileName)),
        ).toContain(file(output));
        const redirect = program.getSourceFile(file('project/src/value.ts'));
        expect(redirect?.isDeclarationFile).toBe(true);
        expect(toPortablePath(redirect!.fileName)).toBe(file(output));
        expect(
          program
            .getOptionsDiagnostics()
            .filter((diagnostic) => diagnostic.code === 6305),
        ).toEqual([]);
      }
      if (
        original.options.rootDir === undefined &&
        original.options.outDir !== undefined
      ) {
        const unpinned = structuredClone(projected);
        delete (unpinned.compilerOptions as Record<string, unknown>).rootDir;
        await writeFile(checkPath, JSON.stringify(unpinned));
        const program = ts.createProgram({
          rootNames: [file('consumer.ts')],
          options: { noLib: true, types: [], module: ts.ModuleKind.CommonJS },
          projectReferences: [{ path: checkPath }],
        });
        // The same compiler loses the original declaration mapping if the
        // generated config directory is allowed to become the composite root.
        expect(
          program.getSourceFile(file('project/src/value.ts'))
            ?.isDeclarationFile,
        ).not.toBe(true);
      }
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });
});
