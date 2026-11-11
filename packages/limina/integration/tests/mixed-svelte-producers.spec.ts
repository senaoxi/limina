import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { createSemanticRepairFixture } from '../../src/__tests__/helpers/semantic-repair';
import type { GeneratedTsconfigGraphManifest } from '../../src/core/build-graph/manifest-types';
import { readJson, resolveGeneratedPath } from '../helpers/assertions';
import { runLimina } from '../helpers/run-limina';

const require = createRequire(import.meta.url);

it('builds independent producers before resolving all Svelte consumers and repairs missing output on a new invocation', async () => {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      name: 'mixed-checkers',
      private: true,
      type: 'module',
      packageManager: 'npm@11.6.1',
      devDependencies: {
        svelte: '4.0.0',
        'svelte-check': '4.0.0',
        svelte2tsx: '0.7.61',
        typescript: '6.0.3',
        vue: '3.5.43',
        'vue-tsc': '3.2.4',
        '@types/estree': '1.0.9',
      },
    }),
    'package-lock.json': '{"lockfileVersion":3,"packages":{"":{}}}',
    'limina.config.mjs':
      'export default {scope:{source:{include:["**/*.{ts,vue,svelte}"]},checkers:{auto:{}}},graph:{rules:{}},source:{knip:false},proof:{allowlist:[]}};',
    'a/a.svelte':
      '<script lang="ts">import B from "../b/b.vue"; import C from "../c/c.svelte"; import { g } from "../g/g.ts"; const components = [B, C]; export let value: number = g;</script><p>{value} {components.length}</p>',
    'b/b.vue':
      '<script setup lang="ts">import { e } from "../e/e.ts"; const value: number = e;</script><template>{{ value }}</template>',
    'c/c.svelte':
      '<script lang="ts">import { f } from "../f/f.ts"; export let value: number = f;</script><p>{value}</p>',
    'd/d.ts': 'import A from "../a/a.svelte"; export const d = A;',
    'e/e.ts': 'export const e: number = 1;',
    'f/f.ts': 'export const f: number = 1;',
    'g/g.ts':
      'import H from "../h/h.svelte"; export const component = H; export const g: number = 1;',
    'h/h.svelte':
      '<script lang="ts">export let value: number = 1;</script><p>{value}</p>',
  };
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
    files[`tsconfig.${name}.json`] = JSON.stringify({
      compilerOptions: {
        composite: true,
        declaration: true,
        emitDeclarationOnly: true,
        strict: true,
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        allowImportingTsExtensions: true,
        types: [],
        typeRoots: ['./node_modules/@types'],
        lib: ['ES2022', 'DOM'],
        outDir: `./.build/${name}`,
      },
      include: [`${name}/**/*`],
    });
  }
  files['tsconfig.json'] = JSON.stringify({
    files: [],
    references: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((name) => ({
      path: `./tsconfig.${name}.json`,
    })),
  });
  files['svelte.config.js'] = 'export default {};';
  const fixture = await createSemanticRepairFixture(files);
  try {
    for (const [name, installed] of [
      ['typescript', 'typescript'],
      ['vue', 'vue'],
      ['vue-tsc', 'vue-tsc'],
      ['svelte', 'svelte-v4-min'],
      ['svelte2tsx', 'svelte2tsx'],
      ['svelte-check', 'svelte-check-v4-min'],
    ]) {
      const directory = path.dirname(
        require.resolve(`${installed}/package.json`),
      );
      await mkdir(fixture.path('node_modules'), { recursive: true });
      await symlink(
        await realpath(directory),
        fixture.path('node_modules', name!),
        'junction',
      );
    }
    // Svelte 4's published declarations import estree, but that release only
    // declared its types as a dev dependency. Supply the real installed types
    // through the fixture's explicit type roots; keep strict library checking.
    const walker = import.meta.resolve(
      'estree-walker',
      pathToFileURL(require.resolve('svelte-v4-min/package.json')).href,
    );
    const estree = path.dirname(
      createRequire(walker).resolve('@types/estree/package.json'),
    );
    await mkdir(fixture.path('node_modules/@types'), { recursive: true });
    await symlink(
      await realpath(estree),
      fixture.path('node_modules/@types/estree'),
      'junction',
    );
    const binary = require.resolve('svelte-check-v4-min/bin/svelte-check');
    const binDirectory = fixture.path('node_modules/.bin');
    await mkdir(binDirectory, { recursive: true });
    const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
    await writeFile(
      path.join(binDirectory, 'svelte-check'),
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(binary)} "$@"\n`,
    );
    await chmod(path.join(binDirectory, 'svelte-check'), 0o755);
    await writeFile(
      path.join(binDirectory, 'svelte-check.cmd'),
      `@ECHO OFF\r\n"${process.execPath}" "${binary}" %*\r\n`,
    );
    const check = async (commandArguments: string[]) => {
      const timeout = 180_000;
      const result = await runLimina({
        fixtureName: 'mixed-svelte-producers',
        cwd: fixture.root,
        args: commandArguments,
        // Cold graph preparation, all five framework checks and finalization
        // can exceed two minutes on Windows even when every checker succeeds.
        timeout,
      });
      expect(
        result.timedOut,
        `limina ${commandArguments.join(' ')} exceeded ${timeout}ms\n${result.stdout}${result.stderr}`,
      ).toBe(false);
      expect(result.code, result.stdout + result.stderr).toBe(0);
      return result.stdout + result.stderr;
    };
    const cold = await check(['check']);
    expect(cold).toContain('checker build');
    expect(cold).toContain('graph materialize');
    expect(cold.indexOf('checker build')).toBeLessThan(
      cold.indexOf('graph materialize'),
    );
    const manifest = JSON.parse(
      await readFile(fixture.path('.limina/manifest.json'), 'utf8'),
    ) as GeneratedTsconfigGraphManifest;
    expect(manifest.version).toBe(7);
    expect(
      manifest.targets.framework
        .map((target) => target.config)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual(['a', 'c', 'd', 'g', 'h'].map((name) => `tsconfig.${name}.json`));
    expect(
      manifest.dependencyEdges
        .map((edge) => `${edge.fromConfig}->${edge.toConfig}`)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual(
      ['a->b', 'a->c', 'a->g', 'b->e', 'c->f', 'd->a', 'g->h']
        .map((edge) =>
          edge
            .split('->')
            .map((name) => `tsconfig.${name}.json`)
            .join('->'),
        )
        .sort((a, b) => a.localeCompare(b)),
    );
    const expectedReferences: Record<string, string[]> = {
      a: [manifest.checkers['vue-tsc']!.sourceToDts['tsconfig.b.json']!],
      c: [],
      d: [],
      g: [],
      h: [],
    };
    for (const [name, references] of Object.entries(expectedReferences)) {
      const checkConfig = fixture.path(
        `.limina/check/tsconfig.${name}.check.json`,
      );
      const projected = await readJson<{
        compilerOptions: { rootDir: string };
        references: { path: string }[];
      }>(checkConfig);
      expect(
        projected.references.map((reference) =>
          resolveGeneratedPath(checkConfig, reference.path),
        ),
      ).toEqual(references.map((reference) => fixture.path(reference)));
      expect(projected.compilerOptions.rootDir).toBe(fixture.path());
    }
    const declaration = manifest.declarationBindings!.find(
      (entry) => entry.sourceFile === 'b/b.vue',
    )!;
    expect(declaration).toBeDefined();
    await rm(fixture.path(declaration.outputFile));
    const warm = await check(['checker', 'typecheck']);
    expect(warm).toContain('Checked 5 checker typecheck entry(s)');
    expect(
      await readFile(fixture.path(declaration.outputFile), 'utf8'),
    ).toContain('DefineComponent');
  } finally {
    await fixture.cleanup();
  }
  // Both real CLI invocations keep finite budgets, plus setup and cleanup.
}, 420_000);
