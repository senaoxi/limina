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
import { createWorkspaceExportsResolutionIndex } from '../core/workspace/exports';
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
          const astroSemanticProject = createAstroSemanticProject({
            analysisGeneration: 1,
            configPath,
            packageRootDir: directory,
            projectFingerprint: mode,
            readSnapshot: () => ({
              compilerOptions: options,
              configClosure: [],
              fileNames: [file],
              projectReferences: [],
              checkerExtensions: ['.astro'],
            }),
          });
          const index = await createWorkspaceExportsResolutionIndex({
            config: {
              config: {},
              rootDir: directory,
              configPath: path.join(directory, 'limina.config.mjs'),
            },
            importAnalysis,
            packages: [{ directory, name: manifest.name, manifest }],
            profiles: [
              {
                options,
                configPath,
                resolverConfigPath: configPath,
                extensions: ['.astro'],
                checkerPresets: [],
                astroSemanticProject,
              },
            ],
          });
          const result = index.get(configPath, manifest.name)!;
          expect(result.hasTypeScriptStableEntry).toBe(mode === 'active');
          expect(result.typeScriptResolvedFileName).toBe(
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
        const containingFile = path.join(directory, 'package.json');
        const native = ts.resolveModuleName(
          manifest.name,
          containingFile,
          options,
          ts.sys,
        ).resolvedModule;
        const index = await createWorkspaceExportsResolutionIndex({
          config: {
            rootDir: directory,
            configPath: path.join(directory, 'limina.config.mjs'),
            config: {},
          },
          importAnalysis,
          packages: [{ directory, name: manifest.name, manifest }],
          profiles: [
            {
              configPath,
              resolverConfigPath: configPath,
              options,
              checkerPresets: ['tsc'],
              extensions: ['.ts', '.d.ts', '.vue'],
            },
          ],
        });
        const result = index.get(configPath, manifest.name)!;
        expect(result.hasTypeScriptStableEntry).toBe(stable);
        expect(result.typeScriptResolvedFileName).toBe(
          native ? toPortablePath(native.resolvedFileName) : null,
        );
      } finally {
        importAnalysis.dispose?.();
        await rm(rootDir, { recursive: true, force: true });
      }
    },
  );
});
