import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { FixtureSetupOperation } from './detector-fixture-types';

interface SourcePackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly name: string;
  readonly version: string;
}

interface OutputPackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly exports: Readonly<Record<string, string>>;
  readonly license?: string;
  readonly name: string;
  readonly private?: boolean;
  readonly type: 'module';
  readonly types: string;
  readonly version: string;
}

const OUTPUT_DECLARATION = 'export declare const value: number;\n';
const OUTPUT_JAVASCRIPT = 'export const value = 1;\n';
const OUTPUT_LICENSE = 'MIT\n';
const OUTPUT_README = '# Release fixture\n';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseSourcePackageManifest(
  content: string,
  manifestPath: string,
): SourcePackageManifest {
  const value: unknown = JSON.parse(content);
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    typeof value.version !== 'string'
  ) {
    throw new Error(
      `Release fixture package manifest must define string name and version fields: ${manifestPath}`,
    );
  }

  let dependencies: Record<string, string> | undefined;
  if (value.dependencies !== undefined) {
    if (!isRecord(value.dependencies)) {
      throw new Error(
        `Release fixture package dependencies must be an object: ${manifestPath}`,
      );
    }
    dependencies = {};
    for (const [name, specifier] of Object.entries(value.dependencies)) {
      if (typeof specifier !== 'string') {
        throw new TypeError(
          `Release fixture package dependency specifiers must be strings: ${manifestPath}`,
        );
      }
      dependencies[name] = specifier;
    }
  }

  return {
    dependencies,
    name: value.name,
    version: value.version,
  };
}

function resolvePublishedDependencySpecifier(
  specifier: string,
  dependencyVersion: string | undefined,
): string {
  if (
    specifier.startsWith('workspace:') ||
    specifier.startsWith('link:') ||
    specifier.startsWith('file:')
  ) {
    return `^${dependencyVersion ?? '1.0.0'}`;
  }
  return specifier;
}

function createOutputPackageManifest(options: {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly license?: string | false;
  readonly name: string;
  readonly private?: boolean;
  readonly version: string;
}): OutputPackageManifest {
  return {
    exports: {
      '.': './index.js',
    },
    ...(options.license === false ? {} : { license: options.license ?? 'MIT' }),
    name: options.name,
    type: 'module',
    types: './index.d.ts',
    version: options.version,
    ...(options.dependencies && Object.keys(options.dependencies).length > 0
      ? { dependencies: options.dependencies }
      : {}),
    ...(options.private === undefined ? {} : { private: options.private }),
  };
}

function createOutputPackageManifestFromSource(options: {
  readonly packageVersions: ReadonlyMap<string, string>;
  readonly source: SourcePackageManifest;
}): OutputPackageManifest {
  const dependencies = options.source.dependencies
    ? Object.fromEntries(
        Object.entries(options.source.dependencies).map(([name, specifier]) => [
          name,
          resolvePublishedDependencySpecifier(
            specifier,
            options.packageVersions.get(name),
          ),
        ]),
      )
    : undefined;

  return createOutputPackageManifest({
    dependencies,
    name: options.source.name,
    version: options.source.version,
  });
}

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

export async function materializeReleaseFixtureOutputs(options: {
  readonly repoRoot: string;
}): Promise<void> {
  const packagesRoot = path.join(options.repoRoot, 'packages');
  const packageEntries = (await readdir(packagesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  const packages = await Promise.all(
    packageEntries.map(async (entry) => {
      const packageRoot = path.join(packagesRoot, entry.name);
      const manifestPath = path.join(packageRoot, 'package.json');
      const source = parseSourcePackageManifest(
        await readFile(manifestPath, 'utf8'),
        manifestPath,
      );
      return { packageRoot, source };
    }),
  );
  const packageVersions = new Map(
    packages.map(({ source }) => [source.name, source.version] as const),
  );

  await Promise.all(
    packages.map(async ({ packageRoot, source }) => {
      const outputRoot = path.join(packageRoot, 'dist');
      const outputManifest = createOutputPackageManifestFromSource({
        packageVersions,
        source,
      });
      await mkdir(outputRoot, { recursive: true });
      await Promise.all([
        writeFile(
          path.join(outputRoot, 'index.d.ts'),
          OUTPUT_DECLARATION,
          'utf8',
        ),
        writeFile(path.join(outputRoot, 'index.js'), OUTPUT_JAVASCRIPT, 'utf8'),
        writeFile(path.join(outputRoot, 'LICENSE.md'), OUTPUT_LICENSE, 'utf8'),
        writeFile(
          path.join(outputRoot, 'package.json'),
          `${JSON.stringify(outputManifest, null, 2)}\n`,
          'utf8',
        ),
        writeFile(path.join(outputRoot, 'README.md'), OUTPUT_README, 'utf8'),
      ]);
    }),
  );
}
