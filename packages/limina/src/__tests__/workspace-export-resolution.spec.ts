import { createAstroSemanticProject } from '#checkers';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createImportAnalysisContext } from '../core/import-analysis/context';
import { collectTypeScriptSourceTextImports } from '../core/import-analysis/typescript-imports';
import { toPortablePath } from './helpers/path';

describe('workspace export resolver proof', () => {
  it.each(['astro-v7-min', 'astro-v7-current'])(
    'retains actual Astro resolver authority (%s)',
    async (astroPackage) => {
      const directory = await realpath(
        await mkdtemp(path.join(tmpdir(), 'limina-astro-export-proof-')),
      );
      const req = createRequire(import.meta.url);
      const importAnalysis = createImportAnalysisContext();
      try {
        for (const [name, target] of [
          ['astro', path.dirname(req.resolve(`${astroPackage}/package.json`))],
          [
            '@astrojs/check',
            await realpath(path.resolve('node_modules/@astrojs/check')),
          ],
          ['typescript', path.dirname(req.resolve('typescript/package.json'))],
        ]) {
          const installed = path.join(directory, 'node_modules', name!);
          await mkdir(path.dirname(installed), { recursive: true });
          await symlink(target!, installed, 'junction');
        }
        const file = path.join(directory, 'Widget.astro');
        const configPath = path.join(directory, 'tsconfig.json');
        await writeFile(file, '---\nconst value = 1;\n---\n<div>{value}</div>');
        await writeFile(configPath, '{}');
        const options = {
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          types: [],
        };
        for (const mode of ['active', 'inactive', 'blocked']) {
          const exports = {
            '.':
              mode === 'active'
                ? './Widget.astro'
                : mode === 'inactive'
                  ? { never: './Widget.astro' }
                  : { types: null, default: './Widget.astro' },
          };
          const manifest = {
            name: 'astro-export-fixture',
            type: 'module',
            dependencies: {
              astro: '*',
              '@astrojs/check': '*',
              typescript: '*',
            },
            exports,
          };
          await writeFile(
            path.join(directory, 'package.json'),
            JSON.stringify(manifest),
          );
          const consumerPath = path.join(directory, 'Consumer.astro');
          await writeFile(
            consumerPath,
            `---\nimport Widget from '${manifest.name}';\n---\n<Widget />`,
          );
          const astroSemanticProject = createAstroSemanticProject({
            analysisGeneration: 1,
            configPath,
            packageRootDir: directory,
            projectFingerprint: mode,
            readSnapshot: () => ({
              compilerOptions: options,
              configClosure: [],
              fileNames: [file, consumerPath],
              projectReferences: [],
              checkerExtensions: ['.astro'],
            }),
          });
          const prepared = importAnalysis.prepareCheckerSemanticDependencies({
            filePath: consumerPath,
            context: {
              configPath,
              resolverConfigPath: configPath,
              extensions: ['.astro'],
              checkerPresets: [],
              semanticFamily: 'astro',
              astroSemanticProject,
            },
          });
          expect(prepared.kind).toBe('supported');
          if (prepared.kind !== 'supported')
            throw new Error(JSON.stringify(prepared));
          const fact = prepared.facts.find(
            (fact) => fact.importRecord.specifier === manifest.name,
          );
          expect(fact).toBeDefined();
          expect(fact!.target?.resolvedFileName ?? null).toBe(
            mode === 'active' ? toPortablePath(file) : null,
          );
        }
      } finally {
        importAnalysis.dispose?.();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    {
      label: 'active types',
      exports: { '.': { types: './index.d.ts' } },
      conditions: [],
      stable: true,
    },
    {
      label: 'inactive condition',
      exports: { '.': { never: './index.d.ts' } },
      conditions: [],
      stable: false,
    },
    {
      label: 'active custom condition',
      exports: { '.': { custom: './index.d.ts' } },
      conditions: ['custom'],
      stable: true,
    },
    {
      label: 'null types before default',
      exports: { '.': { types: null, default: './index.d.ts' } },
      conditions: [],
      stable: false,
    },
    {
      label: 'outside target',
      exports: { '.': './../outside.d.ts' },
      conditions: [],
      stable: false,
    },
    {
      label: 'directory target',
      exports: { '.': './dir' },
      conditions: [],
      stable: false,
    },
    {
      label: 'native framework suffix',
      exports: { '.': './Widget.vue' },
      conditions: [],
      stable: false,
    },
  ])(
    'requires actual resolution for $label',
    async ({ exports, conditions, stable }) => {
      const rootDir = await mkdtemp(
        path.join(tmpdir(), 'limina-export-proof-'),
      );
      const directory = path.join(rootDir, 'pkg');
      const importAnalysis = createImportAnalysisContext();
      try {
        await mkdir(directory);
        await writeFile(path.join(rootDir, 'outside.d.ts'), 'export {};');
        const manifest = { name: 'proof-fixture', type: 'module', exports };
        await writeFile(
          path.join(directory, 'package.json'),
          JSON.stringify(manifest),
        );
        await writeFile(
          path.join(directory, 'index.d.ts'),
          'export declare const value: number;',
        );
        await mkdir(path.join(directory, 'dir'));
        await writeFile(path.join(directory, 'dir/index.d.ts'), 'export {};');
        await writeFile(
          path.join(directory, 'Widget.vue'),
          '<script setup lang="ts">const value = 1;</script>',
        );
        const configPath = path.join(directory, 'tsconfig.json');
        await writeFile(configPath, '{}');
        const options = {
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          customConditions: conditions,
        };
        const containingFile = path.join(directory, 'consumer.mts');
        const sourceText = `import value from '${manifest.name}'; void value;`;
        await writeFile(containingFile, sourceText);
        const record = collectTypeScriptSourceTextImports({
          filePath: containingFile,
          sourceText,
        })[0]!;
        const native = ts.resolveModuleName(
          manifest.name,
          containingFile,
          options,
          ts.sys,
        ).resolvedModule;
        const evidence = importAnalysis.resolveCheckerImportEvidence(
          record,
          containingFile,
          options,
          {
            configPath,
            resolverConfigPath: configPath,
            extensions: ['.ts', '.d.ts', '.vue'],
            checkerPresets: ['tsc'],
            semanticFamily: 'typescript',
          },
        );
        expect(evidence.typeScriptResolution?.resolvedFileName ?? null).toBe(
          native ? toPortablePath(native.resolvedFileName) : null,
        );
        expect(evidence.typeScriptResolution !== null).toBe(stable);
      } finally {
        importAnalysis.dispose?.();
        await rm(rootDir, { recursive: true, force: true });
      }
    },
  );
});
