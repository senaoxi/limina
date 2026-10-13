import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVueProjectSemanticIdentity } from '../checker/vue-semantic-identity';
import { AnalysisInputDriftError } from '../core/analysis-cache/contracts';
import { NativeAnalysisCache } from '../core/analysis-cache/native-cache';
import type { VueQueryResults } from '../core/analysis-cache/vue-contracts';
import * as vueIdentity from '../core/analysis-cache/vue-identity';
import * as vueSchema from '../core/analysis-cache/vue-schema';
import { createVueCacheFixture } from './helpers/vue-analysis-cache';

const fixtures: ReturnType<typeof createVueCacheFixture>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});
function fixture() {
  const f = createVueCacheFixture();
  fixtures.push(f);
  const { identity } = createVueProjectSemanticIdentity({
    configPath: f.path('vue/tsconfig.json'),
    projectRootDir: f.rootDir,
  });
  const cache = new NativeAnalysisCache('fixture', undefined, 'fixture-config');
  return { ...f, identity, cache };
}

describe('Vue query reuse within an analysis invocation', () => {
  it('isolates collected and returned data and stops reusing after domain invalidation', () => {
    const f = fixture();
    const evidence: VueQueryResults['evidence'] = {
      kind: 'ambient',
      declarationFilePaths: [f.path('vue/src/ambient.d.ts')],
      modulePattern: '*.css',
    };
    const collect = vi.fn(() => evidence);
    const query = {
      identity: f.identity,
      kind: 'evidence' as const,
      request: 'theme.css',
      collect,
    };
    const expected = structuredClone(evidence);
    expect(f.cache.vue.query(query)).toEqual(expected);
    const decode = vi.spyOn(vueSchema, 'decodeVueQuery');
    const identity = vi.spyOn(vueIdentity, 'vueContextId');
    evidence.declarationFilePaths.length = 0;
    const restored = f.cache.vue.query(query);
    expect(restored).toEqual(expected);
    if (restored?.kind === 'ambient') restored.declarationFilePaths.length = 0;
    expect(f.cache.vue.query(query)).toEqual(expected);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(identity).not.toHaveBeenCalled();
    expect(f.cache.metrics.vueQueryHits).toBe(2);
    f.cache.inputs.invalidateDomain(f.identity.configPath);
    expect(f.cache.vue.query(query)).toEqual(evidence);
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it('keeps distinct physical identities separate even with the same query request', () => {
    const f = fixture();
    const query = { kind: 'evidence' as const, request: 'theme.css' };
    f.cache.vue.query({
      ...query,
      identity: f.identity,
      collect: () => ({ kind: 'missing' }),
    });
    const changed = {
      ...f.identity,
      options: { ...f.identity.options, paths: { '*': ['./other/*'] } },
    };
    const collect = vi.fn(() => ({
      kind: 'checker-source' as const,
      filePath: f.path('vue/src/value.ts'),
    }));
    expect(f.cache.vue.query({ ...query, identity: changed, collect })).toEqual(
      { kind: 'checker-source', filePath: f.path('vue/src/value.ts') },
    );
    expect(collect).toHaveBeenCalledTimes(1);
    expect(f.cache.metrics.vueQueryHits ?? 0).toBe(0);
  });

  it.each([
    'options',
    'vue-options',
    'profiles',
    'overlay',
    'generation',
  ] as const)(
    'rejects %s identity drift before capturing memoized data',
    (input) => {
      const f = fixture();
      f.cache.vue.query({
        identity: f.identity,
        kind: 'evidence',
        request: 'theme.css',
        collect: () => ({ kind: 'missing' }),
      });
      switch (input) {
        case 'options': {
          f.identity.options.paths = { '*': ['./other/*'] };
          break;
        }
        case 'vue-options': {
          (f.identity.vueOptions as Record<string, unknown>).strictTemplates =
            true;
          break;
        }
        case 'profiles': {
          f.identity.profilesByFileName = new Map();
          break;
        }
        case 'overlay': {
          f.identity.virtualFiles = new Map([
            [f.path('virtual.ts'), 'export {};'],
          ]);
          break;
        }
        case 'generation': {
          f.identity.generation += 1;
          break;
        }
      }
      expect(() => f.cache.snapshot()).toThrow(AnalysisInputDriftError);
    },
  );
});
