import type { ResolvedCheckerConfig } from '#config/runner';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  collectMissingCheckerPeerDependencies,
  formatMissingCheckerPeerDependencies,
} from '../checker/peers';
import {
  checkerToolchainDependencyContracts,
  externalCheckerDependencyContracts,
  isSupportedDependencyVersion,
  liminaRuntimeDependencyContracts,
  vueCheckerToolchainPackages,
} from '../dependency-contract';
import { createFixturePathResolver } from './helpers/path';

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

function checker(name: 'tsc' | 'tsgo' | 'vue-tsc'): ResolvedCheckerConfig {
  return { exclude: [], extensions: [], include: [], name };
}

async function createPackageManifest(options: {
  packageName: string;
  rootDir: string;
  version: string;
}): Promise<string> {
  const fixturePath = createFixturePathResolver(options.rootDir);
  const manifestPath = fixturePath(
    'node_modules',
    ...options.packageName.split('/'),
    'package.json',
  );
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      name: options.packageName,
      version: options.version,
    })}\n`,
  );
  return manifestPath;
}

describe('dependency ownership contract', () => {
  it('matches the source peer manifest without promoting checker internals', async () => {
    const manifestPath = fileURLToPath(
      new URL('../../package.json', import.meta.url),
    );
    const manifest = JSON.parse(
      await readFile(manifestPath, 'utf8'),
    ) as PackageManifest;
    const contracts = {
      ...checkerToolchainDependencyContracts,
      ...liminaRuntimeDependencyContracts,
      ...externalCheckerDependencyContracts,
    };

    expect(manifest.peerDependencies).toEqual(
      Object.fromEntries(
        Object.values(contracts).map((contract) => [
          contract.packageName,
          contract.supportedRange,
        ]),
      ),
    );
    expect(Object.keys(manifest.peerDependenciesMeta ?? {}).sort()).toEqual(
      Object.values(contracts)
        .filter((contract) => contract.optional)
        .map((contract) => contract.packageName)
        .sort(),
    );
    for (const contract of Object.values(contracts)) {
      expect(
        manifest.peerDependenciesMeta?.[contract.packageName]?.optional ===
          true,
      ).toBe(contract.optional);
    }
    for (const packageName of vueCheckerToolchainPackages.slice(0, 2)) {
      for (const section of [
        manifest.dependencies,
        manifest.devDependencies,
        manifest.optionalDependencies,
        manifest.peerDependencies,
        manifest.peerDependenciesMeta,
      ]) {
        expect(section?.[packageName]).toBeUndefined();
      }
    }
  });

  it('checks native-preview prereleases against the external checker range', () => {
    const contract =
      externalCheckerDependencyContracts['@typescript/native-preview'];

    expect(
      isSupportedDependencyVersion({
        contract,
        version: '7.0.0-dev.20260421.2',
      }),
    ).toBe(true);
    expect(
      isSupportedDependencyVersion({
        contract,
        version: '7.0.0-dev.20260420.1',
      }),
    ).toBe(false);
  });

  it('reports missing runtime and external checker ownership separately', () => {
    const unavailablePackages = new Map<string, string>();
    const problems = collectMissingCheckerPeerDependencies({
      checkers: [checker('tsc'), checker('vue-tsc')],
      projectRootDir: '/fixture',
      resolvePackage: ({ packageName }) => unavailablePackages.get(packageName),
    });
    const message = formatMissingCheckerPeerDependencies(problems);

    expect(message).toContain('Missing Limina runtime dependency:');
    expect(message).toContain('Missing external checker:');
    expect(message).toContain('typescript');
    expect(message).toContain('vue-tsc');
  });

  it('reports an unsupported checker version from the execution scope', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-dependency-'));
    try {
      const manifestPath = await createPackageManifest({
        packageName: 'vue-tsc',
        rootDir,
        version: '3.3.0',
      });
      const problems = collectMissingCheckerPeerDependencies({
        checkers: [checker('vue-tsc')],
        projectRootDir: rootDir,
        resolvePackage: () => manifestPath,
      });
      const message = formatMissingCheckerPeerDependencies(problems);

      expect(message).toContain('Unsupported external checker:');
      expect(message).toContain('installed 3.3.0');
      expect(message).toContain(
        'supported >=2.2.0 <=2.2.12 || >=3.2.0 <=3.2.4',
      );
      expect(message).toContain('adjust vue-tsc');
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('keeps Limina TypeScript and external checker resolution in separate scopes', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-dependency-'));
    try {
      await writeFile(path.join(rootDir, 'package.json'), '{"private":true}\n');
      await createPackageManifest({
        packageName: 'typescript',
        rootDir,
        version: '1.0.0',
      });
      await createPackageManifest({
        packageName: 'vue-tsc',
        rootDir,
        version: '3.3.0',
      });

      expect(
        collectMissingCheckerPeerDependencies({
          checkers: [checker('tsc')],
          projectRootDir: rootDir,
        }),
      ).toEqual([]);
      expect(
        collectMissingCheckerPeerDependencies({
          checkers: [checker('vue-tsc')],
          projectRootDir: rootDir,
        }),
      ).toMatchObject([
        {
          failureKind: 'unsupported',
          installedVersion: '3.3.0',
          ownership: 'external-checker',
          packageName: 'vue-tsc',
          resolutionScope: rootDir,
        },
      ]);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });
});
