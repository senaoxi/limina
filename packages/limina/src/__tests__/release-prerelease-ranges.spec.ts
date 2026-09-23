import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createReleaseConsistencyState } from '../package-check/release/consistency/dependencies';
import { validatePackedManifest } from '../package-check/release/packed/manifest';
import { createFixturePathResolver } from './helpers/path';

const fixturePath = createFixturePathResolver(
  path.resolve('release-range-fixture'),
);

describe.each([
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
] as const)('packed %s ranges', (section) => {
  it.each([
    { version: '1.2.0', range: '^1.0.0', accepted: true },
    { version: '2.0.0', range: '^1.0.0', accepted: false },
    { version: '1.1.0-beta.1', range: '^1.0.0', accepted: false },
    { version: '1.0.1-next.0', range: '~1.0.0', accepted: false },
    { version: '2.0.0-beta.2', range: '>=1.0.0 <3.0.0', accepted: false },
    { version: '1.1.0-beta.1', range: '^1.1.0-beta.0', accepted: true },
    { version: '1.2.0-beta.1', range: '^1.1.0-beta.0', accepted: false },
    { version: '1.1.0+build.1', range: '^1.0.0', accepted: true },
  ])(
    'checks $version against $range using ordinary consumer semantics',
    ({ version, range, accepted }) => {
      const state = createReleaseConsistencyState();
      state.directWorkspaceDependencies.push({
        dependencyName: '@fixture/dep',
        sectionName: section,
        targetPackage: {
          name: '@fixture/dep',
          directory: fixturePath('dep'),
          manifest: { name: '@fixture/dep', version },
        },
      });
      validatePackedManifest({
        manifest: {
          name: '@fixture/root',
          version: '1.0.0',
          [section]: { '@fixture/dep': range },
        },
        packedManifestPath: 'root.tgz#package.json',
        packageManifestPath: fixturePath('root/package.json'),
        rootPackageName: '@fixture/root',
        state,
      });
      expect(state.findings.map((finding) => finding.reason)).toEqual(
        accepted ? [] : ['packed-dependency-range-mismatch'],
      );
    },
  );
});
