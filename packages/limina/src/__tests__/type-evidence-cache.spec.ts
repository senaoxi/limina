import type { ResolvedLiminaConfig } from '#config/runner';
import path from 'node:path';
import type ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import {
  createImportTypeEvidenceCacheKey,
  createTypeEvidenceProviderCacheKey,
  TypeEvidenceGenerationCache,
  type TypeEvidenceProvider,
} from '../core/type-evidence';
import { createPreflightGenerationController } from '../preflight/generation';
import { LiminaPreflightManager } from '../preflight/manager';

function createProvider(dispose = vi.fn()): TypeEvidenceProvider {
  return {
    dispose,
    query: () => ({ kind: 'missing' }),
  };
}

describe('type evidence generation cache', () => {
  it('creates one provider and Program for one checker/config/generation key', () => {
    const cache = new TypeEvidenceGenerationCache();
    const providerCreate = vi.fn(() => createProvider());
    const programDispose = vi.fn();
    const programCreate = vi.fn(() => ({
      dispose: programDispose,
      program: {} as ts.Program,
    }));
    const key = createTypeEvidenceProviderCacheKey({
      checkerName: 'typescript',
      configPath: path.join(process.cwd(), 'tsconfig.json'),
      generation: 3,
      preset: 'tsc',
    });

    expect(cache.getOrCreateProvider(key, providerCreate)).toBe(
      cache.getOrCreateProvider(key, providerCreate),
    );
    expect(cache.getOrCreateProgram(key, programCreate)).toBe(
      cache.getOrCreateProgram(key, programCreate),
    );
    expect(providerCreate).toHaveBeenCalledTimes(1);
    expect(programCreate).toHaveBeenCalledTimes(1);

    cache.dispose();
    cache.dispose();

    expect(programDispose).toHaveBeenCalledTimes(1);
  });

  it('releases a completed project provider and Program exactly once', () => {
    const cache = new TypeEvidenceGenerationCache();
    const providerDispose = vi.fn();
    const programDispose = vi.fn();
    const key = createTypeEvidenceProviderCacheKey({
      checkerName: 'vue',
      configPath: path.join(process.cwd(), 'tsconfig.vue.json'),
      generation: 2,
      preset: 'vue-tsc',
    });

    cache.getOrCreateProvider(key, () => createProvider(providerDispose));
    cache.getOrCreateProgram(key, () => ({
      dispose: programDispose,
      program: {} as ts.Program,
    }));
    cache.releaseProviderAndProgram(key);
    cache.releaseProviderAndProgram(key);

    expect(providerDispose).toHaveBeenCalledTimes(1);
    expect(programDispose).toHaveBeenCalledTimes(1);
    expect(cache.typeEvidenceProviderCache.size).toBe(0);
    expect(cache.programCache.size).toBe(0);
    cache.dispose();
    expect(providerDispose).toHaveBeenCalledTimes(1);
    expect(programDispose).toHaveBeenCalledTimes(1);
  });

  it('keys duplicate imports by stable locator occurrence', () => {
    const providerKey = 'provider';
    const createRecord = (occurrence: number) => ({
      filePath: path.join(process.cwd(), 'src/index.ts'),
      kind: 'static' as const,
      line: occurrence + 1,
      locator: {
        occurrence,
        sourceEnd: 20 + occurrence,
        sourceStart: 6 + occurrence,
      },
      specifier: './style.css',
    });

    expect(
      createImportTypeEvidenceCacheKey({
        importRecord: createRecord(0),
        providerKey,
      }),
    ).not.toBe(
      createImportTypeEvidenceCacheKey({
        importRecord: createRecord(1),
        providerKey,
      }),
    );
  });

  it('keeps locator and cache identities stable across platform path separators', () => {
    const providerIdentity = {
      checkerName: 'typescript',
      generation: 4,
      preset: 'tsc',
    };
    const windowsProviderKey = createTypeEvidenceProviderCacheKey({
      ...providerIdentity,
      configPath: 'C:\\repo\\packages\\app\\tsconfig.json',
    });
    const portableProviderKey = createTypeEvidenceProviderCacheKey({
      ...providerIdentity,
      configPath: 'C:/repo/packages/app/tsconfig.json',
    });
    const locator = { occurrence: 1, sourceEnd: 42, sourceStart: 29 };

    expect(windowsProviderKey).toBe(portableProviderKey);
    expect(
      createImportTypeEvidenceCacheKey({
        importRecord: {
          filePath: 'C:\\repo\\packages\\app\\src\\index.ts',
          kind: 'dynamic',
          line: 3,
          locator,
          specifier: './style.css?raw',
        },
        providerKey: windowsProviderKey,
      }),
    ).toBe(
      createImportTypeEvidenceCacheKey({
        importRecord: {
          filePath: 'C:/repo/packages/app/src/index.ts',
          kind: 'dynamic',
          line: 3,
          locator,
          specifier: './style.css?raw',
        },
        providerKey: portableProviderKey,
      }),
    );
  });

  it('disposes the old generation before replacement and at manager shutdown', () => {
    const config = {
      configPath: path.join(process.cwd(), 'limina.config.mts'),
      rootDir: process.cwd(),
    } satisfies ResolvedLiminaConfig;
    const manager = new LiminaPreflightManager({ config });
    const oldProviderDispose = vi.fn();
    const oldProgramDispose = vi.fn();
    const key = createTypeEvidenceProviderCacheKey({
      checkerName: 'typescript',
      configPath: path.join(process.cwd(), 'tsconfig.json'),
      generation: 0,
      preset: 'tsc',
    });

    manager.providers.typeEvidence.cache.getOrCreateProvider(key, () =>
      createProvider(oldProviderDispose),
    );
    manager.providers.typeEvidence.cache.getOrCreateProgram(key, () => ({
      dispose: oldProgramDispose,
      program: {} as ts.Program,
    }));

    createPreflightGenerationController(manager).startNextGeneration();

    expect(oldProviderDispose).toHaveBeenCalledTimes(1);
    expect(oldProgramDispose).toHaveBeenCalledTimes(1);

    const nextProviderDispose = vi.fn();
    manager.providers.typeEvidence.cache.getOrCreateProvider(
      createTypeEvidenceProviderCacheKey({
        checkerName: 'typescript',
        configPath: path.join(process.cwd(), 'tsconfig.json'),
        generation: 1,
        preset: 'tsc',
      }),
      () => createProvider(nextProviderDispose),
    );

    manager.dispose();
    manager.dispose();

    expect(nextProviderDispose).toHaveBeenCalledTimes(1);
    expect(() =>
      createPreflightGenerationController(manager).startNextGeneration(),
    ).toThrow('Preflight manager has been disposed');
  });
});
