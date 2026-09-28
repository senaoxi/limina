import { mkdir, rm, symlink } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { FileOwnerLookup } from '../core/build-graph/file-owner-lookup';
import { selectProviderProject } from '../core/build-graph/provider-selection';
import type { SourceProject } from '../core/build-graph/types';
import { createSemanticRepairFixture } from './helpers/semantic-repair';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixture() {
  const f = await createSemanticRepairFixture({
    'real/value.ts': 'export {};',
    'other/value.ts': 'export {};',
  });
  cleanups.push(f.cleanup);
  await mkdir(f.path('links'));
  await symlink(f.path('real'), f.path('links/alias'), 'junction');
  return f;
}

describe('analysis-local file owner identity', () => {
  it.each([false, true])(
    'matches another checker through its registered path: aliasOwner=%s',
    async (aliasOwner) => {
      const f = await fixture();
      const registered = f.path(
        aliasOwner ? 'links/alias/value.ts' : 'real/value.ts',
      );
      const queried = f.path(
        aliasOwner ? 'real/value.ts' : 'links/alias/value.ts',
      );
      const owner = f.path('provider.json');
      const lookup = new FileOwnerLookup([
        { configPath: owner, fileNames: [registered] },
      ]);
      const project: SourceProject = {
        checkerName: 'vue-tsc',
        configPath: owner,
        configClosure: [],
        context: { checkerPresets: ['vue-tsc'], extensions: [] },
        dtsConfigPath: f.path('provider.dts.json'),
        fileNames: [registered],
        graphRules: [],
        ownedFileNames: [registered],
        outputConfigPath: f.path('output.json'),
        outputOptions: null,
        outputReferences: new Set(),
        packageRootDir: f.root,
        options: {},
        references: new Set(),
        semanticAuthority: {
          kind: 'locked',
          family: 'vue',
          source: 'explicit',
        },
      };
      const consumer: SourceProject = {
        ...project,
        checkerName: 'tsc',
        configPath: f.path('consumer.json'),
        context: { checkerPresets: ['tsc'], extensions: [] },
      };
      expect(
        selectProviderProject({
          consumerProject: consumer,
          providerSourceFilePaths: [queried],
          targetProjects: [project],
        }).kind,
      ).toBe('missing');
      expect(
        selectProviderProject({
          consumerProject: consumer,
          providerSourceFilePaths: lookup.registeredFileNames(queried, owner),
          targetProjects: [project],
        }),
      ).toMatchObject({ kind: 'selected', project });
    },
  );

  it.each([false, true])(
    'maps both alias directions with aliasOwner=%s',
    async (aliasOwner) => {
      const f = await fixture();
      const registered = f.path(
        aliasOwner ? 'links/alias/value.ts' : 'real/value.ts',
      );
      const queried = f.path(
        aliasOwner ? 'real/value.ts' : 'links/alias/value.ts',
      );
      const owner = f.path('tsconfig.json');
      const lookup = new FileOwnerLookup([
        { configPath: owner, fileNames: [registered] },
      ]);
      expect(lookup.get(queried)).toEqual([owner]);
      expect(lookup.registeredFileNames(queried, owner)).toEqual([registered]);
      expect(lookup.get(registered)).toEqual([owner]);
      expect(lookup.isCanonicalAmbiguous(queried)).toBe(false);
    },
  );

  it.each([false, true])(
    'retains exact ownership and all fallback ambiguity with reversed=%s',
    async (reversed) => {
      const f = await fixture();
      const inputs = [
        { configPath: f.path('a.json'), fileNames: [f.path('real/value.ts')] },
        {
          configPath: f.path('b.json'),
          fileNames: [f.path('links/alias/value.ts')],
        },
      ];
      const lookup = new FileOwnerLookup(
        reversed ? inputs.toReversed() : inputs,
      );
      expect(lookup.get(f.path('real/value.ts'))).toEqual([f.path('a.json')]);
      expect(lookup.get(f.path('links/alias/value.ts'))).toEqual([
        f.path('b.json'),
      ]);
      await symlink(f.path('real'), f.path('links/second'), 'junction');
      expect(lookup.get(f.path('links/second/value.ts'))).toEqual([
        f.path('a.json'),
        f.path('b.json'),
      ]);
      expect(lookup.isCanonicalAmbiguous(f.path('links/second/value.ts'))).toBe(
        true,
      );
    },
  );

  it('rebuilds canonical membership after a symlink is retargeted or removed', async () => {
    const f = await fixture();
    const inputs = [
      { configPath: f.path('a.json'), fileNames: [f.path('real/value.ts')] },
    ];
    const first = new FileOwnerLookup(inputs);
    const alias = f.path('links/alias/value.ts');
    expect(first.get(alias)).toEqual([f.path('a.json')]);
    await rm(f.path('links/alias'), { recursive: true });
    await symlink(f.path('other'), f.path('links/alias'), 'junction');
    expect(new FileOwnerLookup(inputs).get(alias)).toBeUndefined();
    await rm(f.path('links/alias'), { recursive: true });
    expect(new FileOwnerLookup(inputs).get(alias)).toBeUndefined();
  });
});
