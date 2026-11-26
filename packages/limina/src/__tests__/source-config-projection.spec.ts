import { stat, utimes, writeFile } from 'node:fs/promises';
import ts from 'typescript';
import { afterEach, expect, test } from 'vitest';
import { parseTypeScriptCommandLine } from '../checker/project-base';
import type {
  AnalysisSnapshot,
  SourceConfigAuthority,
} from '../core/analysis-cache/contracts';
import { NativeAnalysisCache } from '../core/analysis-cache/native-cache';
import { parseAnalysisSnapshot } from '../core/analysis-cache/snapshot-schema';
import {
  collectValidatedWorkspaceContext,
  WorkspaceRegionPathIndex,
} from '../core/workspace/validated-context';
import { roundTripAnalysisSnapshot } from './helpers/analysis-snapshot';
import { withFixtureGovernanceRoot } from './helpers/governance-root';
import { toPortableRelativePaths } from './helpers/path';
import { createSemanticRepairFixture } from './helpers/semantic-repair';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixture(input: Record<string, string> = {}) {
  const manifest = { name: 'source-config-projection', private: true };
  const files = await createSemanticRepairFixture({
    'limina.config.mjs': 'export default {};',
    'package.json': JSON.stringify(manifest),
    'tsconfig.json': JSON.stringify({
      extends: './base',
      include: ['src/**/*.ts'],
    }),
    'base.json': JSON.stringify({ compilerOptions: { strict: true } }),
    'src/index.ts': 'export {};',
    ...input,
  });
  cleanups.push(files.cleanup);
  const config = withFixtureGovernanceRoot({
    configPath: files.path('limina.config.mjs'),
    rootDir: files.root,
  });
  const nativeAuthority = { family: 'typescript', source: 'baseline' } as const;
  const configPath = files.path('tsconfig.json');
  async function invoke(input?: {
    previous?: AnalysisSnapshot;
    authority?: SourceConfigAuthority;
    extraFileExtensions?: readonly ts.FileExtensionInfo[];
    virtualFiles?: ReadonlyMap<string, string>;
  }) {
    const cache = new NativeAnalysisCache('source-config', input?.previous, {
      configVersion: 'fixture',
      previousOrigin: 'prior-disk',
    });
    const project = await cache.configReads.run(() =>
      cache.epoch.run(async () => {
        const context = await collectValidatedWorkspaceContext({
          config,
          rawPackages: [
            { directory: files.root, name: manifest.name, manifest },
          ],
        });
        cache.observePackageScopes(
          new WorkspaceRegionPathIndex(context),
          [configPath],
          [],
        );
        if (input?.authority === undefined)
          cache.recordBundledSourceConfigAuthority({
            configPath,
            ...nativeAuthority,
          });
        else
          cache.recordSourceConfigAuthority({ configPath, ...input.authority });
        return parseTypeScriptCommandLine({
          extraFileExtensions: input?.extraFileExtensions,
          parseOptions: {
            configPath,
            projectRootDir: files.root,
            virtualFiles: input?.virtualFiles,
          },
        });
      }),
    );
    await cache.epoch.assertStable();
    return { cache, project };
  }

  async function seed() {
    const result = await invoke();
    expect(result.cache.metrics.resolvedConfigParses).toBe(1);
    expect(result.cache.metrics.resolvedConfigProjectionHits).toBe(0);
    const persisted = parseAnalysisSnapshot(
      roundTripAnalysisSnapshot(result.cache.snapshot()),
      'source-config',
      'fixture',
    );
    if (persisted === undefined)
      throw new Error('Failed to restore seeded snapshot.');
    return { ...result, persisted };
  }
  return { ...files, configPath, invoke, seed };
}

test('adopts an unchanged projection with a fresh compiler AST and current authority provenance', async () => {
  const f = await fixture({
    'tsconfig.json': JSON.stringify({
      extends: './base',
      compilerOptions: { module: null, rootDirs: null },
      include: ['src/**/*.ts'],
      references: [{ path: './reference' }],
    }),
  });
  const cold = await f.seed();
  const authority = cold.persisted.sourceConfigs[f.configPath].authority;
  const warm = await f.invoke({
    previous: cold.persisted,
    authority: { ...authority, source: 'explicit' },
  });
  expect(warm.cache.metrics.resolvedConfigProjectionHits).toBe(1);
  expect(warm.cache.metrics.resolvedConfigParses).toBe(0);
  expect(
    warm.cache.snapshot().sourceConfigs[f.configPath].authority.source,
  ).toBe('explicit');
  expect(warm.project.parsed.options.strict).toBe(true);
  expect(warm.project.rootSelectors).toEqual(cold.project.rootSelectors);
  expect(warm.project.configClosure).toEqual(cold.project.configClosure);
  expect(warm.project.parsed.options).toStrictEqual(
    cold.project.parsed.options,
  );
  expect(warm.project.parsed.projectReferences).toStrictEqual(
    cold.project.parsed.projectReferences,
  );

  const warmAst = warm.project.parsed.options
    .configFile as ts.TsConfigSourceFile;
  expect(Object.keys(warm.project.parsed.options)).not.toContain('configFile');
  expect(warmAst).not.toBe(cold.project.parsed.options.configFile);
  expect(warmAst.extendedSourceFiles).toEqual([f.path('base.json')]);
  expect(ts.isExpressionStatement(warmAst.statements[0])).toBe(true);
});

test('rejects an inherited config change when its mtime is restored', async () => {
  const f = await fixture();
  const cold = await f.seed();
  const base = f.path('base.json');
  await utimes(base, 1_700_000_000, 1_700_000_000);
  const baseline = await f.invoke({ previous: cold.persisted });
  expect(baseline.cache.metrics.resolvedConfigProjectionHits).toBe(1);
  const previous = await stat(base);
  await writeFile(base, JSON.stringify({ compilerOptions: { strict: false } }));
  await utimes(base, previous.atime, previous.mtime);
  expect((await stat(base)).mtimeMs).toBe(previous.mtimeMs);
  const changed = await f.invoke({ previous: cold.persisted });
  expect(changed.cache.metrics.resolvedConfigProjectionHits).toBe(0);
  expect(changed.cache.metrics.resolvedConfigParses).toBe(1);
  expect(changed.project.parsed.options.strict).toBe(false);
});

test('replays glob membership before adopting an unchanged config closure', async () => {
  const f = await fixture();
  const cold = await f.seed();
  await writeFile(f.path('src/added.ts'), 'export {};');
  const changed = await f.invoke({ previous: cold.persisted });
  expect(changed.cache.metrics.resolvedConfigProjectionHits).toBe(0);
  expect(changed.cache.metrics.resolvedConfigParses).toBe(1);
  expect(
    toPortableRelativePaths(f.root, changed.project.parsed.fileNames),
  ).toEqual(['src/added.ts', 'src/index.ts']);
});

test('rejects a config projection moved from a parser with different root extensions', async () => {
  const f = await fixture({
    'tsconfig.json': JSON.stringify({ include: ['src/**/*'] }),
    'src/view.widget': 'component',
  });
  const native = await f.seed();
  const extended = await f.invoke({
    extraFileExtensions: [
      {
        extension: '.widget',
        isMixedContent: true,
        scriptKind: ts.ScriptKind.Deferred,
      },
    ],
  });
  expect(extended.project.parsed.fileNames).toContain(
    f.path('src/view.widget'),
  );
  const previous = structuredClone(native.persisted);
  const projections = previous.sourceConfigs[f.configPath].projections;
  const alternate =
    extended.cache.snapshot().sourceConfigs[f.configPath].projections;
  const [key] = Object.keys(projections);
  expect(Object.keys(alternate)).toHaveLength(1);
  expect(Object.hasOwn(alternate, key!)).toBe(false);
  projections[key!] = Object.values(alternate)[0]!;
  const current = await f.invoke({ previous });
  expect(current.cache.previous).toBeDefined();
  expect(current.cache.metrics.resolvedConfigProjectionHits).toBe(0);
  expect(current.project.parsed.fileNames).toEqual([f.path('src/index.ts')]);
});

test('rejects a newly winning extends candidate while the old config still exists', async () => {
  const f = await fixture();
  const cold = await f.seed();
  await writeFile(
    f.path('base'),
    JSON.stringify({ compilerOptions: { strict: false } }),
  );
  const changed = await f.invoke({ previous: cold.persisted });
  expect(changed.cache.metrics.resolvedConfigProjectionHits).toBe(0);
  expect(changed.cache.metrics.resolvedConfigParses).toBe(1);
  expect(changed.project.parsed.options.strict).toBe(false);
  expect(
    changed.project.configClosure.map(({ filePath }) => filePath),
  ).toContain(f.path('base'));
});

test('keeps provider switches and virtual overlays on the live parse path', async () => {
  const f = await fixture();
  const cold = await f.seed();
  const authority = cold.persisted.sourceConfigs[f.configPath].authority;
  const changed = await f.invoke({
    previous: cold.persisted,
    authority: { ...authority, provider: 'different-provider' },
  });
  expect(changed.cache.metrics.resolvedConfigProjectionHits).toBe(0);
  expect(changed.cache.metrics.resolvedConfigParses).toBe(1);
  const overlay = await f.invoke({
    previous: cold.persisted,
    virtualFiles: new Map([
      [
        f.path('base.json'),
        JSON.stringify({ compilerOptions: { strict: false } }),
      ],
    ]),
  });
  expect(overlay.cache.metrics.resolvedConfigProjectionHits).toBe(0);
  expect(overlay.cache.metrics.resolvedConfigParses).toBe(1);
  expect(overlay.project.parsed.options.strict).toBe(false);
});
