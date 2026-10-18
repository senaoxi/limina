import { readFileSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cacheMetric,
  createVueCacheFixture,
  type VueCacheRun,
} from './helpers/vue-analysis-cache';

const fixtures: ReturnType<typeof createVueCacheFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});
function fixture() {
  const result = createVueCacheFixture();
  fixtures.push(result);
  return result;
}
function expectRestored(run: VueCacheRun) {
  expect(run.passed).toBe(true);
  expect(run.vuePrograms).toBe(0);
  expect(cacheMetric(run, 'semanticPrograms')).toBe(0);
  expect(cacheMetric(run, 'graphBuilds')).toBe(0);
  expect(cacheMetric(run, 'graphHits')).toBeGreaterThan(0);
}
function expectCold(run: VueCacheRun) {
  expect(run.vuePrograms).toBeGreaterThan(0);
  expect(cacheMetric(run, 'graphBuilds')).toBeGreaterThan(0);
}

// Each case starts multiple real compiler processes. Keep room for Windows
// startup and cold analysis while retaining the warm/forced-cold controls.
describe('persistent Vue and mixed graph analysis', () => {
  it('restores before analysis Programs, rebinds current runtime identities and materializes missing artifacts', () => {
    const f = fixture();
    const cold = f.run();
    expectCold(cold);
    const before = readFileSync(f.snapshotFile(), 'utf8');
    const warm = f.run();
    expectRestored(warm);
    expect(warm.graph).toEqual(cold.graph);
    expect(readFileSync(f.snapshotFile(), 'utf8')).toBe(before);
    rmSync(f.path('.limina/generated'), { recursive: true, force: true });
    const refreshed = f.run({ refresh: true });
    expect(refreshed.passed).toBe(true);
    expect(refreshed.graph).toEqual(cold.graph);
    expect(cacheMetric(refreshed, 'graphHits')).toBeGreaterThan(0);
    expect(refreshed.identities.length).toBeGreaterThan(0);
    expect(
      refreshed.identities.every(
        (identity) => identity.generation > 0 && identity.hasRuntime,
      ),
    ).toBe(true);
  });

  it.each([
    'source',
    'ambient',
    'negative-candidate',
    'config',
    'lock',
  ] as const)(
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
        case 'negative-candidate': {
          f.write('vue/src/value.d.ts', 'export declare const value: 2;');
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
        case 'lock': {
          f.write(
            'package-lock.json',
            '{"lockfileVersion":3,"packages":{"":{}},"revision":2}',
          );
          break;
        }
      }
      const changed = f.run();
      expect(changed.passed).toBe(true);
      expect(cacheMetric(changed, 'graphBuilds')).toBeGreaterThan(0);
      expect(cacheMetric(changed, 'graphHits')).toBe(0);
      const restored = f.run();
      expectRestored(restored);
      expect(restored.graph).toEqual(changed.graph);
      const forced = f.run({ force: true });
      expectCold(forced);
      expect(forced.graph).toEqual(changed.graph);
    },
  );

  it.each(['context', 'query', 'graph-reference'] as const)(
    'rejects incomplete %s coverage instead of restoring a partial graph',
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
        case 'graph-reference': {
          for (const graph of Object.values(snapshot.graphs))
            graph.vueContextIds = [];
          break;
        }
      }
      f.writeSnapshot(snapshot);
      const rebuilt = f.run();
      expect(cacheMetric(rebuilt, 'graphBuilds')).toBeGreaterThan(0);
      expect(cacheMetric(rebuilt, 'graphHits')).toBe(0);
      expectRestored(f.run());
    },
  );

  it('keeps forced, disabled and read-only cache policies for Vue graphs', () => {
    const f = fixture();
    f.run();
    expectRestored(f.run({ cache: 'read-only' }));
    const before = readFileSync(f.snapshotFile(), 'utf8');
    const disabled = f.run({ cache: false });
    expect(disabled.vuePrograms).toBeGreaterThan(0);
    expect(cacheMetric(disabled, 'graphHits')).toBe(0);
    expect(readFileSync(f.snapshotFile(), 'utf8')).toBe(before);
    expectCold(f.run({ force: true }));
    expectRestored(f.run());
  });

  it('keeps custom Vue plugins on the cold path even when the plugin contributes no script', () => {
    const f = fixture();
    f.write('vue/plugin.cjs', 'module.exports = () => ({version: 2.2});');
    const config = JSON.parse(
      readFileSync(f.path('vue/tsconfig.json'), 'utf8'),
    );
    config.vueCompilerOptions = { plugins: ['./plugin.cjs'] };
    f.write('vue/tsconfig.json', JSON.stringify(config));
    expectCold(f.run());
    const second = f.run();
    expectCold(second);
    expect(cacheMetric(second, 'graphHits')).toBe(0);
    expect(Object.keys(f.snapshot().graphs)).toHaveLength(0);
  });
}, 60_000);
