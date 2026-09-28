import type {
  ImporterInfo,
  PackageManifest,
  PackageOwner,
  WorkspacePackage,
} from '#core/workspace/actions';
import { isPathInsideDirectory, normalizeAbsolutePath } from '#utils/path';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nativePath from 'node:path';
import path from 'pathe';
import { describe, expect, it } from 'vitest';
import { createWorkspaceLookupIndex } from '../core/workspace/lookup';
import type { WorkspaceRegionBoundary } from '../core/workspace/regions';
import {
  type ValidatedWorkspaceContext,
  type WorkspacePackageIdentity,
  WorkspaceRegionPathIndex,
} from '../core/workspace/validated-context';
import { canonicalProjectedPathSync } from '../core/workspace/validated/shared';
import {
  createProfilingMetricsRecorder,
  type ProfilingMetricsRecorder,
} from '../profiling/metrics';
import { createFixturePathResolver } from './helpers/path';

interface LinearClassification {
  boundary: WorkspaceRegionBoundary | null;
  package: WorkspacePackage | null;
}

async function createFixture(): Promise<{
  cleanup: () => Promise<void>;
  path: (...segments: string[]) => string;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-workspace-directory-index-')),
  );
  return {
    cleanup: () => rm(rootDir, { force: true, recursive: true }),
    path: createFixturePathResolver(rootDir),
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
    governanceRoot: {
      kind: 'workspace',
      manifestPath: normalizeAbsolutePath(
        path.join(normalizeAbsolutePath(options.rootDir), 'package.json'),
      ),
      manifest: {},
      rootDir: normalizeAbsolutePath(options.rootDir),
      packageManager: 'pnpm',
      descriptor: {
        kind: 'pnpm-workspace',
        path: normalizeAbsolutePath(
          path.join(
            normalizeAbsolutePath(options.rootDir),
            'pnpm-workspace.yaml',
          ),
        ),
      },
    },
  };
}

function containsCanonicalPath(filePath: string, directory: string): boolean {
  return (
    filePath === directory ||
    filePath.startsWith(directory.endsWith('/') ? directory : `${directory}/`)
  );
}

// Test-only oracle for Governance Trie semantic equivalence. Production region
// authority comes from WorkspaceRegionPathIndex, never this linear model.
function linearClassify(
  context: ValidatedWorkspaceContext,
  canonicalPath: string,
): LinearClassification {
  const identity = [...context.packageIdentities]
    .sort(
      (left, right) =>
        right.canonicalDirectory.length - left.canonicalDirectory.length,
    )
    .find((candidate) =>
      containsCanonicalPath(canonicalPath, candidate.canonicalDirectory),
    );
  if (!identity) return { boundary: null, package: null };

  const boundary =
    context.boundaries
      .filter((candidate) =>
        containsCanonicalPath(candidate.rootDir, identity.package.directory),
      )
      .map((candidate) => ({
        boundary: candidate,
        canonicalRootDir: canonicalProjectedPathSync(candidate.rootDir),
      }))
      .sort(
        (left, right) =>
          right.canonicalRootDir.length - left.canonicalRootDir.length,
      )
      .find((candidate) =>
        containsCanonicalPath(canonicalPath, candidate.canonicalRootDir),
      )?.boundary ?? null;
  return { boundary, package: boundary ? null : identity.package };
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
      await symlink(
        physicalRoot,
        aliasRoot,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
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

  it('stops region visits at the governance prefix regardless of source depth', async () => {
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
          'workspace-path-trie-segment-visit',
          'package-boundary',
        ),
      ).toBe(queryCount * (targetPackage.directory.split('/').length + 1));
      expect(
        metricCount(
          metrics,
          'workspace-directory-index-entry',
          'package',
          'workspace-path-index',
        ),
      ).toBe(packageCount);

      const visitsBeforeDeepQuery = metricCount(
        metrics,
        'workspace-path-trie-segment-visit',
      );
      const deepFile = path.join(
        targetPackage.directory,
        'src/features/editor/components/internal/views/missing.ts',
      );
      const deepClassification = pathIndex.classifyPath(deepFile);
      expect(deepClassification.package).toBe(targetPackage);
      expect(
        metricCount(metrics, 'workspace-path-trie-segment-visit') -
          visitsBeforeDeepQuery,
      ).toBe(targetPackage.directory.split('/').length + 1);
      const visitsAfterDeepQuery = metricCount(
        metrics,
        'workspace-path-trie-segment-visit',
      );
      expect(pathIndex.classifyPath(deepFile)).toBe(deepClassification);
      expect(metricCount(metrics, 'workspace-path-trie-segment-visit')).toBe(
        visitsAfterDeepQuery,
      );

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

function expectDifferentialClassifications(
  context: ValidatedWorkspaceContext,
  paths: string[],
): void {
  const current = new WorkspaceRegionPathIndex(context);
  for (const filePath of paths) {
    const canonicalPath = canonicalProjectedPathSync(filePath);
    const expected = linearClassify(context, canonicalPath);
    const actual = current.classifyPath(filePath);
    expect(actual.package, filePath).toBe(expected.package);
    expect(actual.boundary, filePath).toBe(expected.boundary);
  }
}

describe('workspace region adversarial cases', () => {
  it('preserves empty, root-package, drive-prefix and same-root cut semantics', async () => {
    const fixture = await createFixture();
    try {
      const rootDir = fixture.path();
      const rootPackage = createPackage(rootDir, '.', 'root');
      const paths = [
        rootDir,
        `${rootDir}/`,
        fixture.path('missing.ts'),
        fixture.path('foo/bar.ts'),
      ];
      expectDifferentialClassifications(
        createContext({ packages: [], rootDir }),
        paths,
      );
      expectDifferentialClassifications(
        createContext({ packages: [rootPackage], rootDir }),
        paths,
      );
      expectDifferentialClassifications(
        createContext({
          boundaries: [createBoundary(rootDir)],
          packages: [rootPackage],
          rootDir,
        }),
        paths,
      );
    } finally {
      await fixture.cleanup();
    }
    const packages = [
      createPackage('C:/', 'repo/foo', 'c'),
      createPackage('D:/', 'repo/foo', 'd'),
    ];
    expectDifferentialClassifications(
      createContext({ packages, rootDir: 'C:/repo' }),
      [
        'C:\\repo\\foo\\src.ts',
        'D:/repo/foo/src.ts',
        'C:/repo/foobar/src.ts',
        'E:/repo/foo/src.ts',
        'C:/repo/foo/',
      ],
    );
  });

  it('restores owner cuts before visiting sibling governance branches', async () => {
    const fixture = await createFixture();
    try {
      const owner = createPackage(fixture.rootDir, 'a', 'owner');
      const reentry = createPackage(
        fixture.rootDir,
        'a/cut/reentry',
        'reentry',
      );
      const sibling = createPackage(
        fixture.rootDir,
        'a/branch/leaf',
        'sibling',
      );
      const boundary = createBoundary(fixture.path('a/cut'));
      const paths = [
        fixture.path('a/cut/missing.ts'),
        fixture.path('a/cut/reentry/src.ts'),
        fixture.path('a/branch/missing.ts'),
        fixture.path('a/branch/leaf/src.ts'),
      ];
      // The cut subtree is inserted first, then becomes one of two children.
      // Its owner-scoped cut must not leak to the sibling's intermediate node.
      for (const packages of [
        [owner, reentry, sibling],
        [sibling, reentry, owner],
      ]) {
        const context = createContext({
          boundaries: [boundary],
          packages,
          rootDir: fixture.rootDir,
        });
        expectDifferentialClassifications(context, paths);
        const index = new WorkspaceRegionPathIndex(context);
        expect(
          index.findPackageForPath(fixture.path('a/branch/missing.ts')),
        ).toBe(owner);
        expect(
          index.findBoundaryForPath(fixture.path('a/branch/missing.ts')),
        ).toBeNull();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('selects the nearest owner cut before and after repeated re-entry', async () => {
    const fixture = await createFixture();
    try {
      const a = createPackage(fixture.rootDir, 'a', 'a');
      const c = createPackage(fixture.rootDir, 'a/b/c', 'c');
      const external = createPackage(
        fixture.rootDir,
        '../external',
        'external',
      );
      const boundaries = ['a/b', 'a/b/deeper', 'a/b/c/d', 'a/b/c/d/deeper'].map(
        (relative) => createBoundary(fixture.path(relative)),
      );
      const paths = [
        'a',
        'a/src.ts',
        'a/b',
        'a/b/src.ts',
        'a/b/deeper/src.ts',
        'a/b/c',
        'a/b/c/src.ts',
        'a/b/c/d',
        'a/b/c/d/src.ts',
        'a/b/c/d/deeper/src.ts',
        'a/b/c/different/src.ts',
        'ab/src.ts',
        '../external/src.ts',
      ].map((relative) => fixture.path(relative));
      for (const ordered of [boundaries, boundaries.toReversed()]) {
        const context = createContext({
          boundaries: ordered,
          packages: [a, c, external],
          rootDir: fixture.rootDir,
        });
        expectDifferentialClassifications(context, paths);
        const pathIndex = new WorkspaceRegionPathIndex(context);
        const lookup = createWorkspaceLookupIndex({
          importers: [],
          owners: context.packages.map(createOwner),
          packages: context.packages,
          pathIndex,
          rootDir: fixture.rootDir,
        });
        for (const filePath of paths) {
          const classification = pathIndex.classifyPath(filePath);
          expect(lookup.findPackageForFile(filePath), filePath).toBe(
            classification.package,
          );
          expect(lookup.findOwnerForFile(filePath)?.directory ?? null).toBe(
            classification.package?.directory ?? null,
          );
          expect(lookup.isInsideActivatedRegion(filePath), filePath).toBe(
            classification.package !== null,
          );
        }
        expect(lookup.findPackageForFile(fixture.path('a/src.ts'))).toBe(a);
        expect(
          lookup.findPackageForFile(fixture.path('a/b/src.ts')),
        ).toBeNull();
        expect(pathIndex.findBoundaryForPath(fixture.path('a/b/src.ts'))).toBe(
          boundaries[0],
        );
        expect(lookup.findPackageForFile(fixture.path('a/b/c/src.ts'))).toBe(c);
        expect(
          lookup.findPackageForFile(fixture.path('../external/src.ts')),
        ).toBe(external);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('challenges event ordering and missing descendants across generated topologies', async () => {
    const fixture = await createFixture();
    try {
      // Enumerate activation/cut combinations independently at three nested roots.
      // This includes cuts without owners, same-root cuts, repeated cuts, and re-entry.
      for (let mask = 0; mask < 64; mask += 1) {
        const directories = ['a', 'a/b', 'a/b/c'];
        const packages = directories
          .filter((_, index) => mask & (1 << index))
          .map((directory) =>
            createPackage(fixture.rootDir, directory, directory),
          );
        const boundaries = directories
          .filter((_, index) => mask & (1 << (index + 3)))
          .map((directory) => createBoundary(fixture.path(directory)));
        expectDifferentialClassifications(
          createContext({ boundaries, packages, rootDir: fixture.rootDir }),
          directories.flatMap((directory) => [
            fixture.path(directory),
            fixture.path(directory, 'missing/deep/file.ts'),
            fixture.path(`${directory}bar`, 'file.ts'),
          ]),
        );
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps canonical owner attribution when a lexical cut projects above activation', async () => {
    const fixture = await createFixture();
    try {
      await mkdir(fixture.path('physical/owner'), { recursive: true });
      await symlink(
        fixture.path('physical'),
        fixture.path('physical/owner/back'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const owner = createPackage(fixture.rootDir, 'physical/owner', 'owner');
      const boundary = createBoundary(fixture.path('physical/owner/back'));
      const context = createContext({
        boundaries: [boundary],
        packages: [owner],
        rootDir: fixture.rootDir,
      });
      expectDifferentialClassifications(context, [
        fixture.path('physical/owner/missing.ts'),
        fixture.path('physical/owner/back/owner/missing.ts'),
        fixture.path('physical/outside.ts'),
      ]);
      expect(
        new WorkspaceRegionPathIndex(context).findBoundaryForPath(
          fixture.path('physical/owner/missing.ts'),
        ),
      ).toBe(boundary);
    } finally {
      await fixture.cleanup();
    }
  });

  it('preserves source config aliases, missing tails, lexical cache identity and filesystem errors', async () => {
    const fixture = await createFixture();
    try {
      await mkdir(fixture.path('physical/generated'), { recursive: true });
      await writeFile(fixture.path('physical/tsconfig.json'), '{}');
      await writeFile(fixture.path('physical/generated/tsconfig.json'), '{}');
      await symlink(
        fixture.path('physical'),
        fixture.path('alias'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const owner = createPackage(fixture.rootDir, 'alias', 'owner');
      const context = {
        ...createContext({
          boundaries: [createBoundary(fixture.path('alias/generated'))],
          packages: [owner],
          identities: [
            createIdentity(fixture.rootDir, owner, fixture.path('physical')),
          ],
          rootDir: fixture.rootDir,
        }),
        sourceConfigPaths: [
          fixture.path('alias/tsconfig.json'),
          fixture.path('alias/generated/tsconfig.json'),
        ],
      };
      const metrics = createProfilingMetricsRecorder();
      const index = new WorkspaceRegionPathIndex(context, metrics);
      const nativeAliasConfig = nativePath.join(
        fixture.rootDir,
        'alias',
        'tsconfig.json',
      );
      expect(index.isSourceConfigPath(nativeAliasConfig)).toBe(true);
      expect(index.classifyPath(nativeAliasConfig)).toBe(
        index.classifyPath(fixture.path('alias/tsconfig.json')),
      );
      for (const relative of ['alias/tsconfig.json', 'physical/tsconfig.json'])
        expect(index.isSourceConfigPath(fixture.path(relative))).toBe(true);
      for (const relative of [
        'alias/generated/tsconfig.json',
        'physical/generated/tsconfig.json',
        'physical/other.json',
      ])
        expect(index.isSourceConfigPath(fixture.path(relative))).toBe(false);
      const paths = [
        'alias/missing/deep.ts',
        'physical/missing/deep.ts',
        'alias/generated/missing.ts',
        'outside.ts',
      ].map((relative) => fixture.path(relative));
      expectDifferentialClassifications(context, paths);
      for (const filePath of paths) {
        const first = index.classifyPath(filePath);
        const before = metrics.snapshot();
        expect(index.classifyPath(filePath)).toBe(first);
        expect(
          metrics
            .snapshot()
            .filter((metric) => metric.name.startsWith('canonical-')),
        ).toEqual(
          before.filter((metric) => metric.name.startsWith('canonical-')),
        );
      }
      // A link loop produces ELOOP, not a missing-tail projection or outside result.
      if (process.platform !== 'win32') {
        await symlink(fixture.path('loop'), fixture.path('loop'), 'dir');
        expect(() => index.classifyPath(fixture.path('loop/file.ts'))).toThrow(
          expect.objectContaining({ code: 'ELOOP' }),
        );
      }
    } finally {
      await fixture.cleanup();
    }
  });
});
