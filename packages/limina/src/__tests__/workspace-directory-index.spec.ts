import type {
  ImporterInfo,
  PackageManifest,
  PackageOwner,
  WorkspacePackage,
} from '#core/workspace/actions';
import { isPathInsideDirectory, normalizeAbsolutePath } from '#utils/path';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'pathe';
import { describe, expect, it } from 'vitest';
import { createWorkspaceLookupIndex } from '../core/workspace/lookup';
import type { WorkspaceRegionBoundary } from '../core/workspace/regions';
import {
  type ValidatedWorkspaceContext,
  type WorkspacePackageIdentity,
  WorkspaceRegionPathIndex,
} from '../core/workspace/validated-context';
import {
  createProfilingMetricsRecorder,
  type ProfilingMetricsRecorder,
} from '../profiling/metrics';

interface LinearClassification {
  boundary: WorkspaceRegionBoundary | null;
  package: WorkspacePackage | null;
}

async function createFixture(): Promise<{
  cleanup: () => Promise<void>;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-workspace-directory-index-')),
  );
  return {
    cleanup: () => rm(rootDir, { force: true, recursive: true }),
    rootDir,
  };
}

function createPackage(
  rootDir: string,
  relativeDirectory: string,
  name?: string,
): WorkspacePackage {
  const manifest: PackageManifest = name ? { name } : { private: true };
  return {
    directory: normalizeAbsolutePath(path.join(rootDir, relativeDirectory)),
    manifest,
    ...(name ? { name } : {}),
  };
}

function createIdentity(
  rootDir: string,
  workspacePackage: WorkspacePackage,
  canonicalDirectory = workspacePackage.directory,
): WorkspacePackageIdentity {
  return {
    canonicalDirectory: normalizeAbsolutePath(canonicalDirectory),
    displayDirectory: path.relative(rootDir, workspacePackage.directory),
    package: workspacePackage,
  };
}

function createBoundary(rootDir: string): WorkspaceRegionBoundary {
  return {
    excluded: true,
    kind: 'package-scope',
    packageJsonPath: normalizeAbsolutePath(path.join(rootDir, 'package.json')),
    rootDir: normalizeAbsolutePath(rootDir),
  };
}

function createContext(options: {
  boundaries?: WorkspaceRegionBoundary[];
  identities?: WorkspacePackageIdentity[];
  packages: WorkspacePackage[];
  rootDir: string;
}): ValidatedWorkspaceContext {
  return {
    boundaries: options.boundaries ?? [],
    configRootDir: normalizeAbsolutePath(options.rootDir),
    descriptorCandidates: [],
    extendedPackageScopes: [],
    outputRoots: [],
    packageIdentities:
      options.identities ??
      options.packages.map((workspacePackage) =>
        createIdentity(options.rootDir, workspacePackage),
      ),
    packages: options.packages,
    rawPackages: options.packages,
    sourceConfigPaths: [],
    workspaceRootDir: normalizeAbsolutePath(options.rootDir),
  };
}

function linearClassify(
  context: ValidatedWorkspaceContext,
  canonicalPath: string,
): LinearClassification {
  const identities = [...context.packageIdentities].sort(
    (left, right) =>
      right.canonicalDirectory.length - left.canonicalDirectory.length,
  );
  const boundariesByOwner = new Map<
    string,
    { boundary: WorkspaceRegionBoundary; canonicalRootDir: string }[]
  >();

  for (const identity of identities) {
    boundariesByOwner.set(
      identity.canonicalDirectory,
      context.boundaries
        .filter((boundary) =>
          isPathInsideDirectory(boundary.rootDir, identity.package.directory),
        )
        .map((boundary) => ({
          boundary,
          canonicalRootDir: normalizeAbsolutePath(boundary.rootDir),
        })),
    );
  }

  const identity = identities.find((candidate) =>
    isPathInsideDirectory(canonicalPath, candidate.canonicalDirectory),
  );
  if (!identity) return { boundary: null, package: null };

  const matchingBoundaries = (
    boundariesByOwner.get(identity.canonicalDirectory) ?? []
  )
    .filter(({ canonicalRootDir }) =>
      isPathInsideDirectory(canonicalPath, canonicalRootDir),
    )
    .sort(
      (left, right) =>
        right.canonicalRootDir.length - left.canonicalRootDir.length,
    );
  const boundary = matchingBoundaries[0]?.boundary ?? null;
  return {
    boundary,
    package: boundary ? null : identity.package,
  };
}

function createOwner(workspacePackage: WorkspacePackage): PackageOwner {
  return {
    ...workspacePackage,
    packageJsonPath: normalizeAbsolutePath(
      path.join(workspacePackage.directory, 'package.json'),
    ),
  };
}

function createImporter(directory: string, name: string): ImporterInfo {
  return {
    declaredWorkspaceDependencies: new Set(),
    directory: normalizeAbsolutePath(directory),
    name,
  };
}

function linearImporterForFile(options: {
  context: ValidatedWorkspaceContext;
  filePath: string;
  importers: ImporterInfo[];
}): ImporterInfo | null {
  const normalizedFilePath = normalizeAbsolutePath(options.filePath);
  if (normalizedFilePath.split('/').includes('node_modules')) return null;
  if (!linearClassify(options.context, normalizedFilePath).package) return null;

  return (
    options.importers
      .filter((importer) =>
        Boolean(
          linearClassify(
            options.context,
            normalizeAbsolutePath(importer.directory),
          ).package,
        ),
      )
      .find((importer) =>
        isPathInsideDirectory(normalizedFilePath, importer.directory),
      ) ?? null
  );
}

function metricCount(
  metrics: ProfilingMetricsRecorder,
  name: string,
  kind?: string,
  provider?: string,
): number {
  return (
    metrics
      .snapshot()
      .find(
        (metric) =>
          metric.name === name &&
          (kind === undefined || metric.kind === kind) &&
          (provider === undefined || metric.provider === provider),
      )?.count ?? 0
  );
}

function ancestorCount(filePath: string): number {
  let count = 0;
  let currentDirectory = normalizeAbsolutePath(filePath);
  while (true) {
    count += 1;
    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) return count;
    currentDirectory = parentDirectory;
  }
}

describe('workspace canonical directory indexes', () => {
  it('matches the old linear package and boundary selection oracle', async () => {
    const fixture = await createFixture();
    try {
      const rootPackage = createPackage(fixture.rootDir, '.', 'root');
      const fooPackage = createPackage(
        fixture.rootDir,
        'packages/foo',
        '@fixture/foo',
      );
      const foobarPackage = createPackage(
        fixture.rootDir,
        'packages/foobar',
        '@fixture/foobar',
      );
      const namelessPackage = createPackage(
        fixture.rootDir,
        'packages/foo/nested',
      );
      const reentryPackage = createPackage(
        fixture.rootDir,
        'fixtures/deep/reentry',
        '@fixture/reentry',
      );
      const fixtureBoundary = createBoundary(
        path.join(fixture.rootDir, 'fixtures'),
      );
      const equalRootBoundary = createBoundary(
        path.join(fixture.rootDir, 'fixtures'),
      );
      const deepBoundary = createBoundary(
        path.join(fixture.rootDir, 'fixtures/deep'),
      );
      const packageBoundary = createBoundary(
        path.join(fixture.rootDir, 'packages/foo/generated'),
      );
      const packages = [
        rootPackage,
        fooPackage,
        foobarPackage,
        namelessPackage,
        reentryPackage,
      ];
      const context = createContext({
        boundaries: [
          fixtureBoundary,
          equalRootBoundary,
          deepBoundary,
          packageBoundary,
        ],
        packages,
        rootDir: fixture.rootDir,
      });
      const pathIndex = new WorkspaceRegionPathIndex(context);
      const paths = [
        fixture.rootDir,
        path.join(fixture.rootDir, 'README.md'),
        fooPackage.directory,
        path.join(fooPackage.directory, 'package.json'),
        path.join(fooPackage.directory, 'src/missing/index.ts'),
        path.join(foobarPackage.directory, 'src/index.ts'),
        path.join(namelessPackage.directory, 'src/index.ts'),
        path.join(fixture.rootDir, 'fixtures/file.ts'),
        path.join(fixture.rootDir, 'fixtures/deep/file.ts'),
        path.join(reentryPackage.directory, 'src/index.ts'),
        path.join(fooPackage.directory, 'generated/file.ts'),
        path.join(fixture.rootDir, '..', 'outside.ts'),
      ];

      for (const filePath of paths) {
        const actual = pathIndex.classifyPath(filePath);
        const expected = linearClassify(context, actual.canonicalPath);
        expect(actual.package, filePath).toBe(expected.package);
        expect(actual.boundary, filePath).toBe(expected.boundary);
        expect(pathIndex.findPackageForPath(filePath), filePath).toBe(
          expected.package,
        );
        expect(pathIndex.findBoundaryForPath(filePath), filePath).toBe(
          expected.boundary,
        );
        expect(pathIndex.isInsideActivatedRegion(filePath), filePath).toBe(
          Boolean(expected.package),
        );
      }

      expect(
        pathIndex.findBoundaryForPath(
          path.join(fixture.rootDir, 'fixtures/file.ts'),
        ),
      ).toBe(fixtureBoundary);
      expect(
        pathIndex.findBoundaryForPath(
          path.join(fixture.rootDir, 'fixtures/deep/file.ts'),
        ),
      ).toBe(deepBoundary);
      expect(
        pathIndex.findPackageForPath(
          path.join(reentryPackage.directory, 'src/index.ts'),
        ),
      ).toBe(reentryPackage);
    } finally {
      await fixture.cleanup();
    }
  });

  it('preserves stable duplicate identity priority and caches all null combinations', async () => {
    const fixture = await createFixture();
    try {
      const firstPackage = createPackage(fixture.rootDir, '.', 'first');
      const secondPackage = createPackage(fixture.rootDir, '.', 'second');
      const duplicateContext = createContext({
        identities: [
          createIdentity(fixture.rootDir, firstPackage),
          createIdentity(fixture.rootDir, secondPackage),
        ],
        packages: [firstPackage, secondPackage],
        rootDir: fixture.rootDir,
      });
      const duplicateIndex = new WorkspaceRegionPathIndex(duplicateContext);
      expect(duplicateIndex.findPackageForPath(fixture.rootDir)).toBe(
        firstPackage,
      );

      const boundary = createBoundary(path.join(fixture.rootDir, 'generated'));
      const context = createContext({
        boundaries: [boundary],
        packages: [firstPackage],
        rootDir: fixture.rootDir,
      });
      const metrics = createProfilingMetricsRecorder();
      const pathIndex = new WorkspaceRegionPathIndex(context, metrics);
      const insidePath = path.join(fixture.rootDir, 'src/index.ts');
      const boundaryPath = path.join(fixture.rootDir, 'generated/index.ts');
      const outsidePath = path.join(fixture.rootDir, '..', 'outside.ts');

      const inside = pathIndex.classifyPath(insidePath);
      const insideCached = pathIndex.classifyPath(insidePath);
      expect(insideCached).toBe(inside);
      expect(inside).toMatchObject({ boundary: null, package: firstPackage });
      expect(pathIndex.findPackageForPath(insidePath)).toBe(firstPackage);
      expect(pathIndex.findBoundaryForPath(insidePath)).toBeNull();

      const excluded = pathIndex.classifyPath(boundaryPath);
      const excludedCached = pathIndex.classifyPath(boundaryPath);
      expect(excludedCached).toBe(excluded);
      expect(excluded).toMatchObject({ boundary, package: null });
      expect(pathIndex.findPackageForPath(boundaryPath)).toBeNull();
      expect(pathIndex.findBoundaryForPath(boundaryPath)).toBe(boundary);

      const outside = pathIndex.classifyPath(outsidePath);
      const outsideCached = pathIndex.classifyPath(outsidePath);
      expect(outsideCached).toBe(outside);
      expect(outside).toMatchObject({ boundary: null, package: null });
      expect(pathIndex.findPackageForPath(outsidePath)).toBeNull();
      expect(pathIndex.findBoundaryForPath(outsidePath)).toBeNull();

      expect(
        metricCount(
          metrics,
          'workspace-path-classification-miss',
          'package-boundary',
        ),
      ).toBe(3);
      expect(
        metricCount(
          metrics,
          'workspace-path-classification-hit',
          'package-boundary',
        ),
      ).toBe(9);
      expect(
        metricCount(
          metrics,
          'workspace-directory-index-entry',
          'package',
          'workspace-path-index',
        ),
      ).toBe(1);
      expect(
        metricCount(
          metrics,
          'workspace-directory-index-entry',
          'boundary',
          'workspace-path-index',
        ),
      ).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps drive, trailing-separator, and segment-prefix behavior portable', () => {
    const driveRoot = 'C:/repo';
    const fooPackage = createPackage(driveRoot, 'packages/foo', '@fixture/foo');
    const foobarPackage = createPackage(
      driveRoot,
      'packages/foobar',
      '@fixture/foobar',
    );
    const driveIndex = new WorkspaceRegionPathIndex(
      createContext({
        packages: [fooPackage, foobarPackage],
        rootDir: driveRoot,
      }),
    );

    expect(
      driveIndex.findPackageForPath('C:\\repo\\packages\\foo\\src\\index.ts'),
    ).toBe(fooPackage);
    expect(
      driveIndex.findPackageForPath('C:/repo/packages/foobar/src/index.ts'),
    ).toBe(foobarPackage);
    expect(driveIndex.findPackageForPath('C:/repo/packages/foo/')).toBe(
      fooPackage,
    );
  });

  it('shares canonical symlink projection while keeping importer matching lexical', async () => {
    const fixture = await createFixture();
    const physicalRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-workspace-index-physical-')),
    );
    try {
      await mkdir(path.join(physicalRoot, 'generated'), { recursive: true });
      const aliasRoot = path.join(fixture.rootDir, 'alias');
      await symlink(physicalRoot, aliasRoot);
      const workspacePackage = createPackage(
        fixture.rootDir,
        'alias',
        '@fixture/alias',
      );
      const boundary = createBoundary(path.join(aliasRoot, 'generated'));
      const context = createContext({
        boundaries: [boundary],
        identities: [
          createIdentity(fixture.rootDir, workspacePackage, physicalRoot),
        ],
        packages: [workspacePackage],
        rootDir: fixture.rootDir,
      });
      const metrics = createProfilingMetricsRecorder();
      const pathIndex = new WorkspaceRegionPathIndex(context, metrics);
      const aliasBoundaryPath = path.join(aliasRoot, 'generated/missing.ts');
      const physicalBoundaryPath = path.join(
        physicalRoot,
        'generated/missing.ts',
      );
      const aliasClassification = pathIndex.classifyPath(aliasBoundaryPath);
      const physicalClassification =
        pathIndex.classifyPath(physicalBoundaryPath);

      expect(aliasClassification.canonicalPath).toBe(
        physicalClassification.canonicalPath,
      );
      expect(aliasClassification).toMatchObject({ boundary, package: null });
      expect(physicalClassification).toMatchObject({
        boundary,
        package: null,
      });
      expect(
        pathIndex.findPackageForPath(path.join(physicalRoot, 'src/index.ts')),
      ).toBe(workspacePackage);
      const platformAliasRoot = physicalRoot.replace(
        /^\/private\/var\//u,
        '/var/',
      );
      expect(
        pathIndex.classifyPath(path.join(platformAliasRoot, 'src/index.ts'))
          .canonicalPath,
      ).toBe(
        pathIndex.classifyPath(path.join(physicalRoot, 'src/index.ts'))
          .canonicalPath,
      );
      expect(pathIndex.classifyPath(boundary.rootDir)).toMatchObject({
        boundary,
        package: null,
      });

      const aliasImporter = createImporter(aliasRoot, '@fixture/alias');
      const lookup = createWorkspaceLookupIndex({
        importers: [aliasImporter],
        owners: [createOwner(workspacePackage)],
        packages: [workspacePackage],
        pathIndex,
        rootDir: fixture.rootDir,
      });
      expect(
        lookup.findImporterForFile(path.join(aliasRoot, 'src/index.ts')),
      ).toBe(aliasImporter);
      expect(
        lookup.findImporterForFile(path.join(physicalRoot, 'src/index.ts')),
      ).toBeNull();

      const physicalImporter = createImporter(
        physicalRoot,
        '@fixture/physical',
      );
      const sameCanonicalLookup = createWorkspaceLookupIndex({
        importers: [aliasImporter, physicalImporter],
        owners: [createOwner(workspacePackage)],
        packages: [workspacePackage],
        pathIndex,
        rootDir: fixture.rootDir,
      });
      expect(
        sameCanonicalLookup.findImporterForFile(
          path.join(physicalRoot, 'src/index.ts'),
        ),
      ).toBe(physicalImporter);
      expect(
        metricCount(metrics, 'canonical-path-cache-hit', 'projected-path'),
      ).toBeGreaterThan(0);
    } finally {
      await Promise.all([
        fixture.cleanup(),
        rm(physicalRoot, { force: true, recursive: true }),
      ]);
    }
  });

  it('matches the old package, owner, and original-order importer oracle', async () => {
    const fixture = await createFixture();
    try {
      const rootPackage = createPackage(fixture.rootDir, '.', 'root');
      const appPackage = createPackage(
        fixture.rootDir,
        'packages/app',
        '@fixture/app',
      );
      const otherPackage = createPackage(
        fixture.rootDir,
        'packages/other',
        '@fixture/other',
      );
      const packages = [rootPackage, appPackage, otherPackage];
      const context = createContext({ packages, rootDir: fixture.rootDir });
      const rootOwner = createOwner(rootPackage);
      const appOwner = createOwner(appPackage);
      const otherOwner = createOwner(otherPackage);
      const owners = [rootOwner, appOwner, otherOwner];
      const rootImporter = createImporter(fixture.rootDir, 'root');
      const appImporter = createImporter(appPackage.directory, '@fixture/app');
      const duplicateAppImporter = createImporter(
        appPackage.directory,
        '@fixture/app-duplicate',
      );
      const otherImporter = createImporter(
        otherPackage.directory,
        '@fixture/other',
      );
      const outsideImporter = createImporter(
        path.join(fixture.rootDir, '..', 'outside'),
        'outside',
      );
      const importers = [
        rootImporter,
        appImporter,
        duplicateAppImporter,
        otherImporter,
        outsideImporter,
      ];
      const pathIndex = new WorkspaceRegionPathIndex(context);
      const lookup = createWorkspaceLookupIndex({
        importers,
        owners,
        packages,
        pathIndex,
        rootDir: fixture.rootDir,
      });
      const paths = [
        path.join(appPackage.directory, 'src/index.ts'),
        path.join(otherPackage.directory, 'src/index.ts'),
        path.join(fixture.rootDir, 'README.md'),
        path.join(appPackage.directory, 'node_modules/pkg/index.js'),
        path.join(fixture.rootDir, '..', 'outside.ts'),
      ];

      for (const filePath of paths) {
        const classification = pathIndex.classifyPath(filePath);
        const expectedPackage = filePath.split('/').includes('node_modules')
          ? null
          : classification.package;
        const expectedOwner = expectedPackage
          ? (owners.find(
              (owner) => owner.directory === expectedPackage.directory,
            ) ?? null)
          : null;
        expect(lookup.findPackageForFile(filePath), filePath).toBe(
          expectedPackage,
        );
        expect(lookup.findOwnerForFile(filePath), filePath).toBe(expectedOwner);
        expect(lookup.findImporterForFile(filePath), filePath).toBe(
          linearImporterForFile({ context, filePath, importers }),
        );
        expect(lookup.isInsideActivatedRegion(filePath), filePath).toBe(
          Boolean(expectedPackage),
        );
      }

      const appFile = path.join(appPackage.directory, 'src/index.ts');
      expect(lookup.findImporterForFile(appFile)).toBe(rootImporter);

      const nearestFirstLookup = createWorkspaceLookupIndex({
        importers: [appImporter, rootImporter],
        owners,
        packages,
        pathIndex: new WorkspaceRegionPathIndex(context),
        rootDir: fixture.rootDir,
      });
      expect(nearestFirstLookup.findImporterForFile(appFile)).toBe(appImporter);

      const duplicateDirectoryLookup = createWorkspaceLookupIndex({
        importers: [appImporter, duplicateAppImporter],
        owners,
        packages,
        pathIndex: new WorkspaceRegionPathIndex(context),
        rootDir: fixture.rootDir,
      });
      expect(duplicateDirectoryLookup.findImporterForFile(appFile)).toBe(
        appImporter,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('scales query visits with path depth instead of collection size', async () => {
    const fixture = await createFixture();
    try {
      const packageCount = 1000;
      const queryCount = 200;
      const packages = Array.from({ length: packageCount }, (_, index) =>
        createPackage(
          fixture.rootDir,
          `packages/p${index.toString().padStart(4, '0')}`,
          `@fixture/p${index}`,
        ),
      );
      const metrics = createProfilingMetricsRecorder();
      const pathIndex = new WorkspaceRegionPathIndex(
        createContext({ packages, rootDir: fixture.rootDir }),
        metrics,
      );
      const targetPackage = packages.at(-1);
      expect(targetPackage).toBeDefined();
      if (!targetPackage) return;

      for (let index = 0; index < queryCount; index += 1) {
        const filePath = path.join(
          targetPackage.directory,
          `src/file-${index}.ts`,
        );
        expect(pathIndex.findPackageForPath(filePath)).toBe(targetPackage);
        expect(pathIndex.findBoundaryForPath(filePath)).toBeNull();
      }

      expect(
        metricCount(
          metrics,
          'workspace-path-ancestor-visit',
          'package-boundary',
        ),
      ).toBe(queryCount * 3);
      expect(
        metricCount(
          metrics,
          'workspace-path-ancestor-visit',
          'package-identity',
        ),
      ).toBe(0);
      expect(
        metricCount(
          metrics,
          'workspace-directory-index-entry',
          'package',
          'workspace-path-index',
        ),
      ).toBe(packageCount);

      const rootPackage = createPackage(fixture.rootDir, '.', 'root');
      const importerMetrics = createProfilingMetricsRecorder();
      const importerContext = createContext({
        packages: [rootPackage],
        rootDir: fixture.rootDir,
      });
      const importers = Array.from({ length: packageCount }, (_, index) =>
        createImporter(
          path.join(
            fixture.rootDir,
            `importers/i${index.toString().padStart(4, '0')}`,
          ),
          `importer-${index}`,
        ),
      );
      const lookup = createWorkspaceLookupIndex({
        importers,
        metrics: importerMetrics,
        owners: [],
        packages: [rootPackage],
        pathIndex: new WorkspaceRegionPathIndex(
          importerContext,
          importerMetrics,
        ),
        rootDir: fixture.rootDir,
      });
      const importerFile = path.join(
        importers.at(-1)?.directory ?? '',
        'src/index.ts',
      );
      expect(lookup.findImporterForFile(importerFile)).toBe(importers.at(-1));
      expect(
        metricCount(
          importerMetrics,
          'workspace-importer-ancestor-visit',
          'importer',
        ),
      ).toBe(ancestorCount(importerFile));
      expect(
        metricCount(
          importerMetrics,
          'workspace-importer-ancestor-visit',
          'importer',
        ),
      ).toBeLessThan(packageCount / 10);
      expect(
        metricCount(
          importerMetrics,
          'workspace-directory-index-entry',
          'importer',
          'workspace-lookup-index',
        ),
      ).toBe(packageCount);
    } finally {
      await fixture.cleanup();
    }
  });
});
