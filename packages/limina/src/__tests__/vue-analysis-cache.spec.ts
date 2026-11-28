import { compareCodeUnits } from '#utils/collections';
import { readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeData } from '../core/analysis-cache/data-codec';
import { decodeVueQuery } from '../core/analysis-cache/vue-schema';
import { graphMeaning } from './helpers/native-meaning';
import { toPortablePath, toPortableRelativePath } from './helpers/path';
import {
  cacheMetric,
  createVueCacheFixture,
  type VueCacheRun,
} from './helpers/vue-analysis-cache';

const fixtures: ReturnType<typeof createVueCacheFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});
function fixture(options?: Parameters<typeof createVueCacheFixture>[0]) {
  const result = createVueCacheFixture(options);
  fixtures.push(result);
  return result;
}
function expectRestored(run: VueCacheRun) {
  expect(run.passed).toBe(true);
  expect(run.vuePrograms).toBe(0);
  expect(cacheMetric(run, 'semanticPrograms')).toBe(0);
  expect(cacheMetric(run, 'restoredVueContexts')).toBeGreaterThan(0);
  expect(cacheMetric(run, 'graphBuilds')).toBeGreaterThan(0);
}
function expectCold(run: VueCacheRun) {
  expect(run.vuePrograms).toBeGreaterThan(0);
  expect(cacheMetric(run, 'graphBuilds')).toBeGreaterThan(0);
}

function generatedReferences(
  f: ReturnType<typeof fixture>,
  run: VueCacheRun,
  source = 'vue/tsconfig.json',
): string[] {
  const checker = run.graph.manifest.checkers['vue-tsc']!;
  const output = f.path(checker.sourceToDts[source]!);
  const config = JSON.parse(readFileSync(output, 'utf8')) as {
    references?: { path: string }[];
  };
  return (config.references ?? [])
    .map((reference) =>
      toPortablePath(path.resolve(path.dirname(output), reference.path)),
    )
    .sort(compareCodeUnits);
}

function expectedProvider(
  f: ReturnType<typeof fixture>,
  run: VueCacheRun,
  provider = 'vue/provider/tsconfig.json',
): string {
  return f.path(run.graph.manifest.checkers['vue-tsc']!.sourceToDts[provider]!);
}

function vueModuleObservations(f: ReturnType<typeof fixture>) {
  const snapshot = f.snapshot();
  return Object.values(snapshot.vueContexts).flatMap((context) =>
    Object.values(context.moduleResolutions).map(
      ({ result, dependencies }) => ({
        ...(decodeData(result) as {
          resolvedModule?: { resolvedFileName: string };
          failedLookupLocations?: string[];
        }),
        inputs: dependencies.map(({ inputId }) => snapshot.inputs[inputId]),
      }),
    ),
  );
}

function crossProjectFixture(options: { noLib?: boolean } = {}) {
  const f = fixture(options);
  f.write(
    'limina.config.mjs',
    `export default {scope:{source:{include:['vue/src/**/*.{ts,vue}','vue/provider/*.ts','native/src/**/*.ts']},checkers:{'vue-tsc':{include:['vue/tsconfig.json','vue/provider/tsconfig.json']},tsc:{include:['native/tsconfig.json']}}}};`,
  );
  f.write('vue/provider/index.ts', 'export const shared = 1;');
  f.write(
    'vue/provider/tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        composite: true,
        declaration: true,
        noLib: options.noLib,
        types: [],
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        outDir: 'dist',
      },
      include: ['index.ts'],
    }),
  );
  f.write(
    'vue/src/Widget.vue',
    `<script setup lang="ts">import { shared } from '../provider/index.js';</script><template>{{shared}}</template>`,
  );
  return f;
}

// Each case starts multiple real compiler processes. Keep room for Windows
// startup and cold analysis while retaining the warm/forced-cold controls.
describe('persistent Vue and mixed graph analysis', () => {
  it('reuses qualified Vue module requests after a source edit but expires them on a config touch', () => {
    const f = fixture();
    const cold = f.run();
    expectCold(cold);
    expect(cacheMetric(cold, 'vueModuleResolutions')).toBeGreaterThan(0);

    f.write(
      'vue/src/index.ts',
      "import { value } from './value.js'; export const other = value;",
    );
    const changed = f.run();
    expectCold(changed);
    expect(
      cacheMetric(changed, 'restoredVueModuleResolutions'),
    ).toBeGreaterThan(0);
    expect(cacheMetric(changed, 'vueModuleResolutions')).toBeGreaterThan(0);
    expect(cacheMetric(changed, 'vueModuleBackedQueries')).toBeGreaterThan(0);
    expect(cacheMetric(changed, 'vueQueries')).toBeLessThan(
      cacheMetric(cold, 'vueQueries'),
    );
    expect(changed.graph).toEqual(cold.graph);
    const members = () =>
      Object.values(f.snapshot().vueContexts).map((context) => context.members);
    const replayedMembers = members();
    expect(f.run({ force: true }).graph).toEqual(changed.graph);
    expect(replayedMembers).toEqual(members());

    const now = new Date();
    utimesSync(f.path('vue/tsconfig.json'), now, now);
    const touched = f.run();
    expectCold(touched);
    expect(cacheMetric(touched, 'restoredVueModuleResolutions')).toBe(0);
    expect(cacheMetric(touched, 'vueModuleBackedQueries')).toBe(0);
    expect(cacheMetric(touched, 'vueModuleResolutions')).toBeGreaterThan(0);
    expect(touched.graph).toEqual(changed.graph);
  });

  it('reruns Vue requests whose target moves to another Source Config', () => {
    const f = crossProjectFixture({ noLib: true });
    const entry = 'vue/provider/tsconfig.json';
    const first = 'vue/provider/tsconfig.first.json';
    const second = 'vue/provider/tsconfig.second.json';
    const { compilerOptions } = JSON.parse(readFileSync(f.path(entry), 'utf8'));
    const setOwner = (provider: 'first' | 'second') => {
      f.write(
        first,
        JSON.stringify({
          compilerOptions,
          files: provider === 'first' ? ['first.ts', 'index.ts'] : ['first.ts'],
        }),
      );
      f.write(
        second,
        JSON.stringify({
          compilerOptions: { ...compilerOptions, outDir: 'dist-second' },
          files:
            provider === 'second' ? ['second.ts', 'index.ts'] : ['second.ts'],
        }),
      );
    };
    f.write('vue/provider/first.ts', 'export {};');
    f.write('vue/provider/second.ts', 'export {};');
    f.write(
      entry,
      JSON.stringify({
        files: [],
        references: [
          { path: './tsconfig.first.json' },
          { path: './tsconfig.second.json' },
        ],
      }),
    );
    setOwner('first');
    const cold = f.run();
    expectCold(cold);
    expect(generatedReferences(f, cold)).toEqual([
      expectedProvider(f, cold, first),
    ]);
    setOwner('second');
    const changed = f.run();
    expectCold(changed);
    expect(cacheMetric(changed, 'vueModuleOwnerMisses')).toBeGreaterThan(0);
    expect(
      cacheMetric(changed, 'restoredVueModuleResolutions'),
    ).toBeGreaterThan(0);
    expect(generatedReferences(f, changed)).toEqual([
      expectedProvider(f, changed, second),
    ]);
    expect(changed.graph).toEqual(f.run({ force: true }).graph);
  });

  it('restores distinct SFC-only compiler requests without creating a Program', () => {
    const f = fixture();
    f.write(
      'limina.config.mjs',
      `export default {scope:{source:{include:['vue/**/*.vue','providers/**/*.ts']},checkers:{'vue-tsc':{include:['vue/tsconfig.json','providers/*/tsconfig.json']}}}};`,
    );
    const options = {
      composite: true,
      types: [],
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
    };
    f.write(
      'vue/tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          ...options,
          jsx: 'react-jsx',
          jsxImportSource: '../providers/jsx',
          importHelpers: true,
          paths: { tslib: ['../providers/helper/index.ts'] },
        },
        files: ['App.vue'],
      }),
    );
    f.write(
      'vue/App.vue',
      '<script lang="tsx">export const view = <div />;</script>',
    );
    for (const provider of ['jsx', 'helper']) {
      f.write(
        `providers/${provider}/tsconfig.json`,
        JSON.stringify({ compilerOptions: options, include: ['*.ts'] }),
      );
    }
    f.write(
      'providers/jsx/jsx-runtime.ts',
      'export namespace JSX { export interface Element {} export interface IntrinsicElements { div: {} } } export const jsx = () => ({}); export const jsxs = jsx;',
    );
    f.write('providers/helper/index.ts', 'export const helper = 1;');
    const cold = f.run();
    expectCold(cold);
    const targets = [
      expectedProvider(f, cold, 'providers/helper/tsconfig.json'),
      expectedProvider(f, cold, 'providers/jsx/tsconfig.json'),
    ].sort(compareCodeUnits);
    expect(generatedReferences(f, cold)).toEqual(targets);
    const warm = f.run();
    expectRestored(warm);
    expect(generatedReferences(f, warm)).toEqual(targets);
    f.write(
      'vue/App.vue',
      '<script lang="tsx">export const view = <div id="changed" />;</script>',
    );
    const changed = f.run();
    expectCold(changed);
    expect(generatedReferences(f, changed)).toEqual(targets);
    expectRestored(f.run());
  });

  it('requalifies a cached JS service reference when allowJs changes', () => {
    const f = fixture();
    f.write(
      'limina.config.mjs',
      `export default {scope:{source:{include:['vue/**/*.vue','vue/**/*.ts']},checkers:{'vue-tsc':{include:['vue/tsconfig.json','vue/provider/tsconfig.json']}}}};`,
    );
    const options = {
      composite: true,
      types: [],
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      noImplicitAny: false,
    };
    f.write(
      'vue/a.ts',
      'import B from "./provider/B.vue"; export const component = B;',
    );
    f.write(
      'vue/provider/B.vue',
      '<script lang="js">export const value = 1;</script>',
    );
    f.write(
      'vue/provider/tsconfig.json',
      JSON.stringify({
        compilerOptions: { ...options, allowJs: true },
        files: ['B.vue'],
      }),
    );
    for (const isJavaScriptAllowed of [false, true]) {
      f.write(
        'vue/tsconfig.json',
        JSON.stringify({
          compilerOptions: { ...options, allowJs: isJavaScriptAllowed },
          files: ['a.ts'],
        }),
      );
      const rebuilt = f.run();
      expectCold(rebuilt);
      const references = isJavaScriptAllowed
        ? [expectedProvider(f, rebuilt)]
        : [];
      expect(generatedReferences(f, rebuilt)).toEqual(references);
      const warm = f.run();
      expectRestored(warm);
      expect(generatedReferences(f, warm)).toEqual(references);
    }
  });

  it.each(['appears', 'disappears'] as const)(
    'recomputes a configured Vue consumer’s reference when its target %s across processes',
    (change) => {
      const f = fixture();
      f.write(
        'limina.config.mjs',
        `export default {scope:{source:{include:['vue/**/*.vue','vue/**/*.ts']},checkers:{auto:{}}}};`,
      );
      const options = {
        composite: true,
        declaration: true,
        types: [],
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        outDir: 'dist',
      };
      f.write(
        'vue/tsconfig.json',
        JSON.stringify({
          compilerOptions: options,
          files: ['a.ts'],
          vueCompilerOptions: {},
        }),
      );
      f.write(
        'vue/a.ts',
        'import Button from "./provider/Button.vue"; export const component = Button;',
      );
      f.write(
        'vue/provider/tsconfig.json',
        JSON.stringify({ compilerOptions: options, include: ['*.vue'] }),
      );
      f.write(
        'vue/provider/Anchor.vue',
        '<script setup lang="ts">const value = 1;</script>',
      );
      const dependencies = (run: VueCacheRun) =>
        generatedReferences(f, run).filter(
          (target) => target === expectedProvider(f, run),
        );
      const addTarget = () =>
        f.write(
          'vue/provider/Button.vue',
          '<script setup lang="ts">const label = "hello";</script>',
        );
      if (change === 'disappears') addTarget();
      const cold = f.run();
      expect(cold.passed).toBe(true);
      expect(dependencies(cold)).toHaveLength(change === 'appears' ? 0 : 1);
      if (change === 'appears') addTarget();
      else rmSync(f.path('vue/provider/Button.vue'));
      const changed = f.run();
      expect(changed.passed).toBe(true);
      expectCold(changed);
      expect(dependencies(changed)).toHaveLength(change === 'appears' ? 1 : 0);
    },
  );

  it('invalidates producer facts from the previous analysis adapter', () => {
    const f = crossProjectFixture();
    expectCold(f.run());
    const snapshot = f.snapshot();
    snapshot.header.implementation = 'checker-declaration-supplements-v29';
    f.writeSnapshot(snapshot);
    const rebuilt = f.run();
    expectCold(rebuilt);
    expect(cacheMetric(rebuilt, 'semanticPrograms')).toBeGreaterThan(0);
    expect(cacheMetric(rebuilt, 'restoredVueContexts')).toBe(0);
    expectRestored(f.run());
  });

  it('revalidates delegated declaration contexts after hot restoration and revokes an edited owner', () => {
    const f = crossProjectFixture();
    f.write(
      'vue/provider/api.d.ts',
      'export type { shared } from "./index.js";',
    );
    f.write(
      'vue/provider/tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          composite: true,
          declaration: true,
          types: [],
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          outDir: 'dist',
        },
        files: ['api.d.ts', 'index.ts'],
      }),
    );
    f.write(
      'vue/src/Widget.vue',
      '<script setup lang="ts">import type { shared } from "../provider/api"; let value: typeof shared;</script>',
    );
    const cold = f.run();
    expect(cold.passed).toBe(true);
    const warm = f.run();
    expectRestored(warm);
    expect(
      warm.events.some(
        (event) => event.name === 'declaration-candidate' && event.count > 0,
      ),
    ).toBe(true);
    expect(warm.declarationAdapters.length).toBeGreaterThan(0);
    expect(new Set(warm.declarationAdapters)).toEqual(
      new Set(['vue-cli-declaration-candidate-v1']),
    );
    f.write('vue/provider/api.d.ts', 'export declare const shared: number;');
    const changed = f.run();
    expectCold(changed);
  });

  it('restores cross-project Vue declaration references and removes them after the last import changes', () => {
    const f = crossProjectFixture({ noLib: true });
    const cold = f.run();
    expectCold(cold);
    const expected = [expectedProvider(f, cold)];
    expect(generatedReferences(f, cold)).toEqual(expected);
    expect(cacheMetric(cold, 'collectionReplayHits')).toBeGreaterThan(0);
    const warm = f.run();
    expectRestored(warm);
    expect(warm.graph).toEqual(cold.graph);
    expect(generatedReferences(f, warm)).toEqual(expected);
    f.write('vue/src/Widget.vue', '<template>local</template>');
    const changed = f.run();
    expectCold(changed);
    expect(generatedReferences(f, changed)).toEqual([]);
    const restored = f.run();
    expectRestored(restored);
    expect(generatedReferences(f, restored)).toEqual([]);
  }, 90_000);

  it.each(['workspace changes', 'materialized roots disagree'] as const)(
    'rechecks roots selected before Vue build ownership when %s',
    (change) => {
      const f = fixture();
      f.write(
        'limina.config.mjs',
        `export default {scope:{source:{include:['native/src/**/*.ts','vue/src/**/*.{ts,vue}']},checkers:{auto:{}}}};`,
      );
      f.write(
        'native/src/index.ts',
        'export { value } from "../../vue/src/value.js";',
      );
      const vueConfig = JSON.parse(
        readFileSync(f.path('vue/tsconfig.json'), 'utf8'),
      );
      f.write(
        'vue/tsconfig.json',
        JSON.stringify({ ...vueConfig, vueCompilerOptions: {} }),
      );
      f.write('native/src/Widget.vue', '<template>Independent</template>');
      f.write(
        'native/tsconfig.json',
        JSON.stringify({
          compilerOptions: {
            composite: true,
            module: 'ESNext',
            moduleResolution: 'Bundler',
            noLib: true,
            types: [],
          },
          include: ['src/**/*', 'src/**/*.astro', 'src/**/*.svelte'],
        }),
      );
      const declaration = f.path(
        '.limina/tsconfig/checkers/vue-tsc/projects/native/tsconfig.dts.json',
      );
      const toDeclarationRelative = (source: string) =>
        toPortableRelativePath(path.dirname(declaration), f.path(source));
      const expectRoots = (roots: string[]) => {
        const generated: unknown = JSON.parse(
          readFileSync(declaration, 'utf8'),
        );
        expect(generated).toMatchObject({
          files: roots.map(toDeclarationRelative),
          include: [],
          references: [{ path: '../vue/tsconfig.dts.json' }],
        });
      };

      const cold = f.run();
      expect(cold.passed).toBe(true);
      expectCold(cold);
      expectRoots(['native/src/index.ts']);
      rmSync(f.path('.limina/tsconfig'), { force: true, recursive: true });
      const warm = f.run();
      expectRestored(warm);
      expect(warm.graph).toEqual(cold.graph);
      expectRoots(['native/src/index.ts']);

      if (change === 'workspace changes') {
        f.write('native/src/extra.ts', 'export const extra = 1;');
      } else {
        const generated = JSON.parse(readFileSync(declaration, 'utf8'));
        writeFileSync(
          declaration,
          JSON.stringify({
            ...generated,
            files: ['native/src/Widget.vue', 'native/src/index.ts'].map(
              toDeclarationRelative,
            ),
          }),
        );
      }

      const rebuilt = f.run();
      expect(rebuilt.passed).toBe(true);
      expect(cacheMetric(rebuilt, 'graphBuilds')).toBeGreaterThan(0);
      expectRoots(
        change === 'workspace changes'
          ? ['native/src/extra.ts', 'native/src/index.ts']
          : ['native/src/index.ts'],
      );
    },
  );

  it.each([false, true])(
    'recomputes erased generated Vue references (erase roots=%s)',
    (eraseRoots) => {
      const f = crossProjectFixture();
      const cold = f.run();
      expectCold(cold);
      const expected = [expectedProvider(f, cold)];
      expect(generatedReferences(f, cold)).toEqual(expected);
      const declaration = f.path(
        cold.graph.manifest.checkers['vue-tsc']!.sourceToDts[
          'vue/tsconfig.json'
        ]!,
      );
      const original = readFileSync(declaration, 'utf8');
      const config = JSON.parse(original);
      config.references = [];
      if (eraseRoots) config.files = [];
      writeFileSync(declaration, JSON.stringify(config));

      const rebuilt = f.run();
      expectRestored(rebuilt);
      expect(rebuilt.graph).toEqual(cold.graph);
      expect(readFileSync(declaration, 'utf8')).toBe(original);
      expect(generatedReferences(f, rebuilt)).toEqual(expected);
    },
  );

  it('binds restored declaration inputs before Vue execution', () => {
    const f = fixture();
    f.write('vue/dist/input.d.ts', 'export declare const value:number;');
    f.write(
      'vue/src/index.ts',
      'import {value} from "../dist/input.js"; export const result:number=value;',
    );
    expectCold(f.run());
    const warm = f.run({
      executionDrift: {
        path: f.path('vue/dist/input.d.ts'),
        content: 'export declare const value:string;',
      },
    });
    expectRestored(warm);
    expect(warm.execution).toEqual({
      before: 0,
      after: 'admission-rejected',
      starts: 1,
    });
  });

  it('rejects changed source bytes during restored Vue execution with equal mtime and compiler text', () => {
    const f = fixture();
    const file = f.path('vue/src/index.ts');
    const text = `${readFileSync(file, 'utf8')}\n// `;
    writeFileSync(
      file,
      Buffer.concat([Buffer.from(text), Buffer.from([0x80])]),
    );
    utimesSync(file, 1000, 1000);
    expect(f.run().passed).toBe(true);
    const warm = f.run({
      executionDrift: {
        path: file,
        content: `${text}\u{FFFD}`,
        restoreMtime: true,
      },
    });
    expectRestored(warm);
    expect(warm.execution).toEqual({
      before: 0,
      after: 'admission-rejected',
      starts: 1,
    });
  });

  it('rebinds restored Vue runtime identities and materializes missing artifacts', () => {
    const f = fixture();
    const cold = f.run();
    expectCold(cold);
    expect(cold.diagnostics).toEqual(
      expect.arrayContaining([expect.stringContaining('./theme.css')]),
    );
    expect(cold.passed).toBe(true);
    const before = readFileSync(f.snapshotFile(), 'utf8');
    const warm = f.run();
    expectRestored(warm);
    expect(warm.graph).toEqual(cold.graph);
    expect(readFileSync(f.snapshotFile(), 'utf8')).toBe(before);
    const config = f.path(cold.graph.manifest.checkers['vue-tsc']!.entry);
    const original = readFileSync(config);
    rmSync(f.path('.limina/tsconfig'), { recursive: true });

    const refreshed = f.run({ refresh: true });
    expect(refreshed.passed).toBe(true);
    expect(graphMeaning(refreshed.graph)).toEqual(graphMeaning(cold.graph));
    expect(refreshed.vuePrograms).toBe(0);
    expect(cacheMetric(refreshed, 'restoredVueContexts')).toBeGreaterThan(0);
    expect(cacheMetric(refreshed, 'graphBuilds')).toBe(2);
    expect(readFileSync(config)).toEqual(original);
    expect(refreshed.identities.length).toBeGreaterThan(0);
    expect(
      refreshed.identities.every(
        (identity) => identity.generation > 0 && identity.hasRuntime,
      ),
    ).toBe(true);
  });

  function outputTargetFixture() {
    const f = fixture({ noLib: true });
    const config = JSON.parse(
      readFileSync(f.path('vue/tsconfig.json'), 'utf8'),
    );
    config.liminaOptions = {
      outputs: { target: 'ES2020', rootDir: 'src', outDir: 'build' },
    };
    f.write('vue/tsconfig.json', JSON.stringify(config));
    return { f, config };
  }

  it('restores distinct Vue output target contexts after generated artifacts are removed', () => {
    const { f } = outputTargetFixture();
    expectCold(f.run());
    const projected = Object.values(f.snapshot().vueContexts).filter(
      (context) => context.project.sourceConfigPath !== undefined,
    );
    expect(projected).toHaveLength(1);
    rmSync(f.path('.limina/tsconfig'), { recursive: true, force: true });
    expectRestored(f.run());
    expect(projected[0]!.project.sourceConfigPath).toBe(
      f.path('vue/tsconfig.json'),
    );
  });

  it('invalidates a changed Vue output target and restores its replacement', () => {
    const { f, config } = outputTargetFixture();
    expectCold(f.run());
    config.liminaOptions.outputs.target = 'ES2023';
    f.write('vue/tsconfig.json', JSON.stringify(config));
    expectCold(f.run());
    expectRestored(f.run());
  });

  it.each(['source-context', 'missing-query', 'generated-options'] as const)(
    'rebuilds the current Vue output config after %s corruption',
    (corruption) => {
      const { f } = outputTargetFixture();
      const cold = f.run();
      expectCold(cold);
      expect(cold.outputConfigs).toHaveLength(1);
      const [file] = cold.outputConfigs;
      const content = readFileSync(file!, 'utf8');
      expect(JSON.parse(content).compilerOptions.target.toLowerCase()).toBe(
        'es2020',
      );
      if (corruption === 'generated-options') {
        const config = JSON.parse(content);
        config.compilerOptions.target = 'ES2023';
        writeFileSync(file!, JSON.stringify(config));
      } else {
        const snapshot = f.snapshot();
        const source = Object.values(snapshot.vueContexts).find(
          (context) =>
            context.project.configPath === f.path('vue/tsconfig.json'),
        );
        const output = Object.values(snapshot.vueContexts).find(
          (context) => context.project.sourceConfigPath !== undefined,
        );
        expect(source).toBeDefined();
        expect(output).toBeDefined();
        if (corruption === 'source-context')
          output!.identity = source!.identity;
        else {
          const query = output!.queryIds.find(
            (id) => output!.queries[id]?.kind === 'request-inventory',
          );
          expect(query).toBeDefined();
          delete output!.queries[query!];
        }
        f.writeSnapshot(snapshot);
      }
      const repaired = f.run();
      if (corruption === 'generated-options') expectRestored(repaired);
      else expectCold(repaired);
      expect(repaired.passed).toBe(true);
      expect(readFileSync(file!, 'utf8')).toBe(content);
      expectRestored(f.run());
    },
  );

  it('keeps the selected Vue module when a lower-priority declaration sibling appears', () => {
    const f = fixture({ noLib: true });
    const selected = f.path('vue/src/value.ts');
    const sibling = f.path('vue/src/value.d.ts');
    const selection = () =>
      new Set(
        vueModuleObservations(f)
          .map(({ resolvedModule }) => resolvedModule?.resolvedFileName)
          .filter((file) => file === selected || file === sibling),
      );
    const cold = f.run();
    expectCold(cold);
    expect(selection()).toEqual(new Set([selected]));

    f.write('vue/src/value.d.ts', 'export declare const value: 2;');
    const changed = f.run();
    expectRestored(changed);
    expect(selection()).toEqual(new Set([selected]));
    expect(graphMeaning(changed.graph)).toEqual(graphMeaning(cold.graph));
  });

  it('selects a newly present Vue module after probing it as a missing preferred candidate', () => {
    const f = crossProjectFixture({ noLib: true });
    const config = JSON.parse(
      readFileSync(f.path('vue/tsconfig.json'), 'utf8'),
    );
    config.compilerOptions.paths = {
      'fixture-value': ['./preferred/value.d.ts', './provider/index.ts'],
    };
    f.write('vue/tsconfig.json', JSON.stringify(config));
    f.write('vue/preferred/.keep', '');
    f.write(
      'vue/src/Widget.vue',
      '<script setup lang="ts">import { shared } from "fixture-value";</script><template>{{shared}}</template>',
    );
    const preferred = f.path('vue/preferred/value.d.ts');
    const fallback = f.path('vue/provider/index.ts');
    const seed = f.run();
    expectCold(seed);
    expect(generatedReferences(f, seed)).toEqual([expectedProvider(f, seed)]);
    const initialResolution = vueModuleObservations(f).find(
      ({ resolvedModule }) => resolvedModule?.resolvedFileName === fallback,
    );
    expect(initialResolution?.failedLookupLocations).toContain(preferred);
    expect(initialResolution?.inputs).toContainEqual(
      expect.objectContaining({ path: preferred, kind: 'file' }),
    );

    f.write('vue/preferred/value.d.ts', 'export declare const shared: 2;');
    utimesSync(preferred, 1000, 1000);
    const changed = f.run();
    expect(changed.passed).toBe(true);
    expect(cacheMetric(changed, 'vueModuleResolutions')).toBeGreaterThan(0);
    const targets = vueModuleObservations(f).map(
      ({ resolvedModule }) => resolvedModule?.resolvedFileName,
    );
    expect(targets).toContain(preferred);
    expect(targets).not.toContain(fallback);
    expect(generatedReferences(f, changed)).toEqual([]);

    const warm = f.run();
    expectRestored(warm);
    expect(generatedReferences(f, warm)).toEqual([]);
    expect(graphMeaning(warm.graph)).toEqual(graphMeaning(changed.graph));
    const forced = f.run({ force: true });
    expectCold(forced);
    expect(generatedReferences(f, forced)).toEqual([]);
    expect(graphMeaning(forced.graph)).toEqual(graphMeaning(changed.graph));
  });

  it.each(['source', 'ambient', 'config'] as const)(
    'invalidates changed %s inputs and warms the replacement',
    (input) => {
      const f = fixture();
      expectCold(f.run());
      switch (input) {
        case 'source': {
          f.write(
            'vue/src/Widget.vue',
            `<script setup lang="ts">import { value } from './value.js'; const result = value;</script><template>{{result + 1}}</template>`,
          );
          break;
        }
        case 'ambient': {
          f.write(
            'vue/src/ambient.d.ts',
            'declare module "*.css" { const value: number; export default value; }',
          );
          break;
        }
        case 'config': {
          const config = JSON.parse(
            readFileSync(f.path('vue/tsconfig.json'), 'utf8'),
          );
          config.vueCompilerOptions = { strictTemplates: true };
          f.write('vue/tsconfig.json', JSON.stringify(config));
          break;
        }
      }
      const changed = f.run();
      expect(changed.passed).toBe(true);
      expectCold(changed);
      const restored = f.run();
      expectRestored(restored);
      expect(restored.graph).toEqual(changed.graph);
      const forced = f.run({ force: true });
      expectCold(forced);
      expect(forced.graph).toEqual(changed.graph);
    },
  );

  it('restores Vue after a lockfile edit and reobserves an upgraded type package', () => {
    const f = fixture();
    f.write(
      'node_modules/@types/fixture/package.json',
      JSON.stringify({ name: '@types/fixture', version: '1.0.0' }),
    );
    f.write(
      'node_modules/@types/fixture/index.d.ts',
      'declare const installedFixture: number;',
    );
    const config = JSON.parse(
      readFileSync(f.path('vue/tsconfig.json'), 'utf8'),
    );
    config.compilerOptions.types = ['fixture'];
    f.write('vue/tsconfig.json', JSON.stringify(config));
    const seed = f.run();
    expectCold(seed);
    f.write(
      'package-lock.json',
      '{"lockfileVersion":3,"packages":{"":{}},"revision":2}',
    );
    const unchanged = f.run();
    expectRestored(unchanged);
    expect(unchanged.graph).toEqual(seed.graph);
    f.write(
      'node_modules/@types/fixture/package.json',
      JSON.stringify({ name: '@types/fixture', version: '2.0.0' }),
    );
    const changed = f.run();
    expect(changed.passed).toBe(true);
    expectCold(changed);
    expect(changed.graph).toEqual(seed.graph);
  });

  it('retains a reference through unmanaged declarations when a sparse Vue query goes live', () => {
    const f = crossProjectFixture({ noLib: true });
    f.write('vue/src/Widget.vue', '<template><div/></template>');
    f.write(
      'vue/src/index.ts',
      "export { shared } from '../unmanaged/first.js';",
    );
    f.write(
      'vue/unmanaged/first.d.ts',
      "export { shared } from './second.js';",
    );
    f.write(
      'vue/unmanaged/second.d.ts',
      "export { shared } from '../provider/index.js';",
    );
    const cold = f.run();
    const expected = [expectedProvider(f, cold)];
    expect(generatedReferences(f, cold)).toEqual(expected);
    const seed = f.snapshot();
    for (const missing of ['type-environment-entries', 'resolution'] as const) {
      const snapshot = structuredClone(seed);
      const source = Object.values(snapshot.vueContexts).find(
        (context) => context.project.configPath === f.path('vue/tsconfig.json'),
      )!;
      const key = source.queryIds.find((id) => {
        const row = source.queries[id]!;
        return (
          row.kind === missing &&
          (missing === 'type-environment-entries' ||
            decodeVueQuery('resolution', row.data)?.sourceRecord.filePath ===
              f.path('vue/unmanaged/first.d.ts'))
        );
      });
      expect(key).toBeDefined();
      delete source.queries[key!];
      source.queryIds = source.queryIds.filter((id) => id !== key);
      f.writeSnapshot(snapshot);
      const repaired = f.run();
      expect(repaired.passed).toBe(true);
      expect(
        cacheMetric(repaired, 'vueQueries') +
          cacheMetric(repaired, 'vueModuleBackedQueries'),
        missing,
      ).toBeGreaterThan(0);
      expect(generatedReferences(f, repaired)).toEqual(expected);
    }
  });

  it.each(['context', 'query', 'module result'] as const)(
    'rebuilds the graph when the stored %s is incomplete or invalid',
    (input) => {
      const f = fixture();
      f.run();
      expectRestored(f.run());
      const snapshot = f.snapshot();
      const [id, context] = Object.entries(snapshot.vueContexts).find(
        ([, value]) => Object.keys(value.queries).length > 0,
      )!;
      switch (input) {
        case 'context': {
          delete snapshot.vueContexts[id];
          break;
        }
        case 'query': {
          delete context.queries[context.queryIds[0]!];
          break;
        }
        case 'module result': {
          const [module] = Object.values(context.moduleResolutions);
          module!.result = [
            'object',
            [['failedLookupLocations', ['number', 1]]],
          ];
          break;
        }
      }
      f.writeSnapshot(snapshot);
      const rebuilt = f.run();
      expectCold(rebuilt);
      expect(rebuilt.passed).toBe(true);
      const restored = f.run();
      expectRestored(restored);
      expect(restored.graph).toEqual(rebuilt.graph);
    },
  );

  it('keeps forced, disabled and read-only cache policies for Vue graphs', () => {
    const f = fixture();
    f.run();
    expectRestored(f.run({ cache: 'read-only' }));
    const before = readFileSync(f.snapshotFile(), 'utf8');
    const disabled = f.run({ cache: false });
    expect(disabled.vuePrograms).toBeGreaterThan(0);
    expect(cacheMetric(disabled, 'restoredVueContexts')).toBe(0);
    expect(readFileSync(f.snapshotFile(), 'utf8')).toBe(before);
    expectCold(f.run({ force: true }));
    expectRestored(f.run());
  });

  it('keeps custom Vue plugins on the cold path for source and output contexts', () => {
    const f = fixture();
    f.write('vue/plugin.cjs', 'module.exports = () => ({version: 2.2});');
    const config = JSON.parse(
      readFileSync(f.path('vue/tsconfig.json'), 'utf8'),
    );
    config.vueCompilerOptions = { plugins: ['./plugin.cjs'] };
    config.liminaOptions = {
      outputs: { target: 'ES2020', rootDir: 'src', outDir: 'build' },
    };
    f.write('vue/tsconfig.json', JSON.stringify(config));
    expectCold(f.run());
    const second = f.run();
    expectCold(second);
    expect(cacheMetric(second, 'restoredVueContexts')).toBe(0);
    expect(Object.keys(f.snapshot().vueContexts)).toHaveLength(0);
  });
}, 60_000);

it.each([
  {
    name: 'ordinary TS require',
    file: 'index.ts',
    source:
      'declare function require(id: string): unknown; require("../provider/index"); export {};',
    references: 0,
  },
  {
    name: 'JS shadowed require',
    file: 'index.js',
    source:
      '/** @param {(id: string) => unknown} require */ function f(require) { require("../provider/index"); } export {};',
    references: 1,
  },
  {
    name: 'noResolve import',
    file: 'index.ts',
    source: 'import "../provider/index"; export {};',
    references: 0,
    noResolve: true,
  },
])(
  'restores Vue compiler obligations for $name without a new Program',
  (scenario) => {
    const f = crossProjectFixture();
    f.write('vue/src/Widget.vue', '<template><div /></template>');
    f.write(
      'vue/tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          composite: true,
          module: 'ESNext',
          moduleResolution: 'Bundler',
          types: [],
          allowJs: scenario.file.endsWith('.js'),
          noResolve: scenario.noResolve,
        },
        files: [`src/${scenario.file}`],
      }),
    );
    f.write(`vue/src/${scenario.file}`, scenario.source);
    const cold = f.run();
    expectCold(cold);
    const expected =
      scenario.references === 1 ? [expectedProvider(f, cold)] : [];
    expect(generatedReferences(f, cold)).toEqual(expected);
    const warm = f.run();
    expectRestored(warm);
    expect(generatedReferences(f, warm)).toEqual(expected);
  },
);
