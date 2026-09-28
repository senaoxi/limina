import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { FixtureSetupOperation } from './detector-fixture-types';
import {
  createOutputPackageManifest,
  createOutputPackageManifestFromSource,
  parseSourcePackageManifest,
} from './release-fixture-manifest';

const OUTPUT_DECLARATION = 'export declare const value: number;\n';
const OUTPUT_JAVASCRIPT = 'export const value = 1;\n';
const OUTPUT_LICENSE = 'MIT\n';
const OUTPUT_README = '# Release fixture\n';

export function createReleaseOutputPackageSetup(options: {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly license?: string | false;
  readonly packageName?: string;
  readonly private?: boolean;
}): FixtureSetupOperation {
  const packageName = options.packageName ?? 'root';
  const manifest = createOutputPackageManifest({
    dependencies: options.dependencies,
    license: options.license,
    name: `@fixture/release-${packageName}`,
    private: options.private,
    version: '1.0.0',
  });
  return {
    content: `${JSON.stringify(manifest, null, 2)}\n`,
    kind: 'write-file',
    overwrite: true,
    path: `repo/packages/${packageName}/dist/package.json`,
  };
}

export function createReleaseOutputFileSetup(options: {
  readonly content: string;
  readonly fileName: string;
  readonly overwrite?: boolean;
  readonly packageName?: string;
}): FixtureSetupOperation {
  return {
    content: options.content,
    kind: 'write-file',
    overwrite: options.overwrite,
    path: `repo/packages/${options.packageName ?? 'root'}/dist/${options.fileName}`,
  };
}

export function removeReleaseOutputFileSetup(options: {
  readonly fileName: string;
  readonly packageName?: string;
}): FixtureSetupOperation {
  return {
    kind: 'remove-path',
    path: `repo/packages/${options.packageName ?? 'root'}/dist/${options.fileName}`,
  };
}

async function readSourcePackages(packagesRoot: string): Promise<
  {
    packageRoot: string;
    source: ReturnType<typeof parseSourcePackageManifest>;
  }[]
> {
  const packageEntries = (await readdir(packagesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  return Promise.all(
    packageEntries.map(async (entry) => {
      const packageRoot = path.join(packagesRoot, entry.name);
      const manifestPath = path.join(packageRoot, 'package.json');
      return {
        packageRoot,
        source: parseSourcePackageManifest(
          await readFile(manifestPath, 'utf8'),
          manifestPath,
        ),
      };
    }),
  );
}

async function writeOutputPackage(options: {
  outputManifest: ReturnType<typeof createOutputPackageManifestFromSource>;
  packageRoot: string;
}): Promise<void> {
  const outputRoot = path.join(options.packageRoot, 'dist');
  await mkdir(outputRoot, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputRoot, 'index.d.ts'), OUTPUT_DECLARATION, 'utf8'),
    writeFile(path.join(outputRoot, 'index.js'), OUTPUT_JAVASCRIPT, 'utf8'),
    writeFile(path.join(outputRoot, 'LICENSE.md'), OUTPUT_LICENSE, 'utf8'),
    writeFile(
      path.join(outputRoot, 'package.json'),
      `${JSON.stringify(options.outputManifest, null, 2)}\n`,
      'utf8',
    ),
    writeFile(path.join(outputRoot, 'README.md'), OUTPUT_README, 'utf8'),
  ]);
}

export async function materializeReleaseFixtureOutputs(options: {
  readonly repoRoot: string;
}): Promise<void> {
  const packages = await readSourcePackages(
    path.join(options.repoRoot, 'packages'),
  );
  const packageVersions = new Map(
    packages.map(({ source }) => [source.name, source.version] as const),
  );
  await Promise.all(
    packages.map(({ packageRoot, source }) =>
      writeOutputPackage({
        outputManifest: createOutputPackageManifestFromSource({
          packageVersions,
          source,
        }),
        packageRoot,
      }),
    ),
  );
}
