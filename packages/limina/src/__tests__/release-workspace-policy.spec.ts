import type {
  ReleaseContentHashConfigArgs,
  ResolvedLiminaConfig,
} from '#config/runner';
import type { NamedWorkspacePackage } from '#core/workspace/actions';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createReleaseConsistencyState } from '../package-check/release/consistency/dependencies';
import { visitWorkspacePackageDependencies } from '../package-check/release/workspace/dependencies';
import { createFixturePathResolver } from './helpers/path';

const fixturePath = createFixturePathResolver(
  path.resolve('release-policy-fixture'),
);
const name = (value: string) => `@fixture/${value}`;

describe('release policy for every importer', () => {
  const graphs: Record<string, string[]>[] = [
    {
      root: ['left', 'right'],
      left: ['shared'],
      right: ['shared'],
      shared: [],
    },
    {
      root: ['right', 'left'],
      left: ['shared'],
      right: ['shared'],
      shared: [],
    },
    { root: ['left', 'shared'], left: ['shared'], shared: [] },
    { root: ['a'], a: ['b'], b: ['a'] },
  ];
  it.each(graphs)(
    'checks all edges in %j without recursively revisiting packages',
    async (graph) => {
      const packages = new Map<string, NamedWorkspacePackage>(
        Object.entries(graph).map(([key, targets]) => [
          name(key),
          {
            name: name(key),
            directory: fixturePath(key),
            manifest: {
              name: name(key),
              version: '1.0.0',
              dependencies: Object.fromEntries(
                targets.map((target) => [name(target), 'workspace:*']),
              ),
            },
          },
        ]),
      );
      const state = createReleaseConsistencyState();
      state.visitedPackages.add(name('root'));
      for (const key of packages.keys()) {
        state.registryMetadataCache.set(key, {
          kind: 'found',
          metadata: { 'dist-tags': {}, versions: {} },
        });
      }
      const tags: ReleaseContentHashConfigArgs[] = [];
      const ignores: ReleaseContentHashConfigArgs[] = [];
      const config: ResolvedLiminaConfig = {
        rootDir: fixturePath(),
        configPath: fixturePath('limina.config.mjs'),
        release: {
          contentHash: {
            baselineTag: (args) => {
              tags.push(args);
              return `${args.importerName}-baseline`;
            },
            ignore: (args) => {
              ignores.push(args);
              return args.importerName === name('left') ? ['index.js'] : [];
            },
          },
        },
      };
      const root = packages.get(name('root'))!;
      await visitWorkspacePackageDependencies({
        config,
        importerName: root.name,
        isRoot: true,
        manifest: root.manifest,
        manifestPath: fixturePath('root/package.json'),
        state,
        workspacePackagesByName: packages,
      });
      const expected = Object.entries(graph)
        .flatMap(([importer, targets]) =>
          targets.map(
            (dependency) => `${name(importer)} -> ${name(dependency)}`,
          ),
        )
        .sort();
      const pairs = (values: ReleaseContentHashConfigArgs[]) =>
        values
          .map((value) => `${value.importerName} -> ${value.dependencyName}`)
          .sort();
      expect(pairs(tags)).toEqual(expected);
      expect(pairs(ignores)).toEqual(expected);
      expect(
        state.findings
          .flatMap((finding) =>
            finding.code === 'LIMINA_RELEASE_REGISTRY' &&
            finding.facts.kind === 'dist-tag-missing'
              ? [
                  `${finding.facts.importerName} -> ${finding.facts.dependencyName}`,
                ]
              : [],
          )
          .sort(),
      ).toEqual(expected);
      expect(state.visitedPackages.size).toBe(packages.size);
      expect(state.registryMetadataCache.size).toBe(packages.size);
    },
  );
});
