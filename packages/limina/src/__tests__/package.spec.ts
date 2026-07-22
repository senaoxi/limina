import type { ResolvedLiminaConfig } from '#config/runner';
import { normalizeAbsolutePath } from '#utils/path';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiminaCheckRunTaskStats } from '../check-reporting/run-recorder';
import {
  formatCheckIssueSnapshotInventory,
  type LiminaCheckIssue,
} from '../check-reporting/snapshot';
import { LiminaFlowReporter } from '../flow';
import { ReleaseLogger } from '../logger';
import type { ReleaseFinding } from '../package-check/release-findings';

const ANSI_ESCAPE = String.fromCodePoint(0x1b);
const ANSI_PATTERN = new RegExp(
  String.raw`${ANSI_ESCAPE}\[[\d:;<=>?]*[\u0020-\u002F]*[\u0040-\u007E]`,
  'g',
);

function stripAnsi(value: string): string {
  return value.replaceAll(ANSI_PATTERN, '');
}

const packageCheckMocks = vi.hoisted(() => ({
  attwCheckOptions: [] as unknown[],
  attwProblems: [] as unknown[],
  attwRuns: 0,
  packedManifestOverrides: new Map<string, Record<string, unknown>>(),
  packedTarballFiles: new Map<
    string,
    {
      data: Buffer;
      name: string;
    }[]
  >(),
  packedTarballManifests: new Map<string, Record<string, unknown>>(),
  packCalls: [] as string[],
  publintCalls: [] as unknown[],
  publintMessages: [] as unknown[],
  publintRenderedMessages: new Map<string, string>(),
  registryPackages: new Map<string, Record<string, unknown>>(),
  registryResponses: new Map<
    string,
    {
      body?: unknown;
      bodyError?: Error;
      fetchError?: Error;
      jsonError?: Error;
      status: number;
      statusText: string;
    }
  >(),
  registryTarballs: new Map<string, Buffer>(),
  unpackCalls: [] as string[],
}));

vi.mock('@publint/pack', async () => {
  const fs = await import('node:fs/promises');
  const { default: pathModule } = await import('node:path');

  async function collectPackedFiles(
    outDir: string,
    directoryPath = outDir,
  ): Promise<
    {
      data: Buffer;
      name: string;
    }[]
  > {
    const entries = await fs.readdir(directoryPath, {
      withFileTypes: true,
    });
    const files: {
      data: Buffer;
      name: string;
    }[] = [];

    for (const entry of entries) {
      const absolutePath = pathModule.join(directoryPath, entry.name);

      if (entry.isDirectory()) {
        files.push(...(await collectPackedFiles(outDir, absolutePath)));
        continue;
      }

      const relativePath = pathModule
        .relative(outDir, absolutePath)
        .replaceAll(pathModule.sep, '/');

      files.push({
        data: await fs.readFile(absolutePath),
        name: `package/${relativePath}`,
      });
    }

    return files;
  }

  return {
    pack: vi.fn(
      async (
        outDir: string,
        options: {
          destination: string;
        },
      ) => {
        const normalizedOutDir = pathModule.normalize(outDir);

        packageCheckMocks.packCalls.push(normalizedOutDir);
        const tarballPath = pathModule.join(options.destination, 'package.tgz');
        const packageJson = JSON.parse(
          await fs.readFile(pathModule.join(outDir, 'package.json'), 'utf8'),
        ) as Record<string, unknown>;
        const packedManifest =
          packageCheckMocks.packedManifestOverrides.get(normalizedOutDir) ??
          packageJson;
        const tarballData = `mock tarball ${packageCheckMocks.packCalls.length}`;
        const packedFiles = await collectPackedFiles(outDir);
        const packageJsonIndex = packedFiles.findIndex(
          (file) => file.name === 'package/package.json',
        );
        const packageJsonFile = {
          data: Buffer.from(JSON.stringify(packedManifest)),
          name: 'package/package.json',
        };

        if (packageJsonIndex === -1) {
          packedFiles.push(packageJsonFile);
        } else {
          packedFiles[packageJsonIndex] = packageJsonFile;
        }

        packageCheckMocks.packedTarballManifests.set(
          tarballData,
          packedManifest,
        );
        packageCheckMocks.packedTarballFiles.set(tarballData, packedFiles);
        await fs.writeFile(tarballPath, tarballData);

        return tarballPath;
      },
    ),
    unpack: vi.fn(async (tarball: Uint8Array) => {
      const tarballData = Buffer.from(tarball).toString('utf8');

      packageCheckMocks.unpackCalls.push(tarballData);
      const manifest =
        packageCheckMocks.packedTarballManifests.get(tarballData) ?? {};
      const files = packageCheckMocks.packedTarballFiles.get(tarballData) ?? [
        {
          data: Buffer.from(JSON.stringify(manifest)),
          name: 'package/package.json',
        },
      ];

      return {
        files,
        rootDir: 'package',
      };
    }),
  };
});

vi.mock('publint', () => ({
  publint: vi.fn(async (options: unknown) => {
    packageCheckMocks.publintCalls.push(options);

    return {
      messages: packageCheckMocks.publintMessages,
      pkg: {},
    };
  }),
}));

vi.mock('publint/utils', () => ({
  formatMessage: vi.fn(
    (message: { code: string }) =>
      packageCheckMocks.publintRenderedMessages.get(message.code) ??
      'mock publint message',
  ),
}));

vi.mock('@arethetypeswrong/core', () => ({
  checkPackage: vi.fn(async (_pkg: unknown, options: unknown) => {
    packageCheckMocks.attwRuns += 1;
    packageCheckMocks.attwCheckOptions.push(options);

    return {
      problems: packageCheckMocks.attwProblems,
      types: true,
    };
  }),
  createPackageFromTarballData: vi.fn(() => ({
    package: 'mock',
  })),
}));

const { collectRawWorkspacePackages } = await import(
  '../core/workspace/actions'
);
const { auditPublishedPackageBoundaries, packOutputTarball } = await import(
  '../package-check/runner'
);
const { assertPackageReleaseConsistency, PackageReleaseConsistencyError } =
  await import('../package-check/release-consistency');
const { runPackageCheck } = await import('../commands/package');
const { runReleaseCheck } = await import('../commands/release');
const { LiminaPreflightManager } = await import('../preflight');

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

async function createOutputPackage(
  files: Record<string, string>,
  manifest: Record<string, unknown> = {},
  options: {
    includePublicMetadata?: boolean;
  } = {},
): Promise<{
  cleanup: () => Promise<void>;
  outDir: string;
  rootDir: string;
}> {
  const rootDir = await createWorkspaceRoot();
  const outDir = path.join(rootDir, 'output', 'package');
  const outputFiles = {
    ...((options.includePublicMetadata ?? true)
      ? {
          'LICENSE.md': 'MIT\n',
          'README.md': '# Example package\n',
        }
      : {}),
    ...files,
  };

  await writeText(
    path.join(outDir, 'package.json'),
    JSON.stringify({
      dependencies: {
        '@example/dep': '1.0.0',
      },
      exports: {
        '.': './index.js',
      },
      license: 'MIT',
      name: '@example/pkg',
      types: './index.d.ts',
      version: '1.0.0',
      ...manifest,
    }),
  );

  for (const [relativePath, source] of Object.entries(outputFiles)) {
    await writeText(path.join(outDir, relativePath), source);
  }

  return {
    cleanup: async () => {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    },
    outDir,
    rootDir,
  };
}

async function createWorkspacePackage(
  rootDir: string,
  packageName: string,
  manifest: Record<string, unknown>,
  outputManifest: Record<string, unknown> = manifest,
): Promise<string> {
  const packageDirName = packageName.split('/').at(-1) ?? packageName;
  const packageDir = path.join(rootDir, 'packages', packageDirName);
  const outDir = path.join(packageDir, 'dist');

  await writeText(
    path.join(packageDir, 'package.json'),
    JSON.stringify({
      name: packageName,
      version: '1.0.0',
      ...manifest,
    }),
  );
  await writeText(path.join(packageDir, 'src/index.ts'), 'export {};\n');
  await writeText(
    path.join(outDir, 'package.json'),
    JSON.stringify({
      dependencies: {},
      exports: {
        '.': './index.js',
      },
      license: 'MIT',
      name: packageName,
      types: './index.d.ts',
      version: '1.0.0',
      ...outputManifest,
    }),
  );
  await writeText(path.join(outDir, 'index.js'), 'export const value = 1;\n');
  await writeText(path.join(outDir, 'README.md'), '# Example package\n');
  await writeText(path.join(outDir, 'LICENSE.md'), 'MIT\n');

  return outDir;
}

async function createWorkspaceRoot(): Promise<string> {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-package-root-'));

  await writeText(
    path.join(rootDir, 'pnpm-workspace.yaml'),
    'packages:\n  - packages/*\n',
  );

  return rootDir;
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

function waitForAbort(signal: AbortSignal | null | undefined): Promise<never> {
  if (!signal) {
    return Promise.reject(new Error('expected registry request signal'));
  }

  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }

  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    });
  });
}

function createPublishedTarballUrl(
  packageName: string,
  version: string,
): string {
  const tarballName = packageName.replace(/^@/u, '').replaceAll('/', '-');

  return `https://registry.npmjs.org/${encodeURIComponent(packageName)}/-/${tarballName}-${version}.tgz`;
}

function createIntegrity(
  data: string | Buffer,
  algorithm: 'sha256' | 'sha512' = 'sha512',
): string {
  return `${algorithm}-${createHash(algorithm).update(data).digest('base64')}`;
}

function createShasum(data: string | Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function createPublishedPackageFiles(
  packageName: string,
  version: string,
  options: {
    files?: Record<string, string>;
    manifest?: Record<string, unknown>;
  } = {},
): {
  data: Buffer;
  name: string;
}[] {
  const manifest = {
    dependencies: {},
    exports: {
      '.': './index.js',
    },
    license: 'MIT',
    name: packageName,
    types: './index.d.ts',
    version,
    ...options.manifest,
  };
  const files = {
    'LICENSE.md': 'MIT\n',
    'README.md': '# Example package\n',
    'index.js': 'export const value = 1;\n',
    'package.json': JSON.stringify(manifest),
    ...options.files,
  };

  return Object.entries(files).map(([relativePath, source]) => ({
    data: Buffer.from(source),
    name: `package/${relativePath}`,
  }));
}

function registerPublishedPackage(
  packageName: string,
  version: string,
  options:
    | string
    | {
        distTags?: Record<string, string>;
        files?: Record<string, string>;
        includeIntegrity?: boolean;
        includeTarballUrl?: boolean;
        integrity?: string;
        manifest?: Record<string, unknown>;
        registerTarball?: boolean;
        shasum?: string;
        versions?: Record<string, unknown>;
      } = {},
): void {
  const normalizedOptions = typeof options === 'string' ? {} : options;
  const tarballUrl = createPublishedTarballUrl(packageName, version);
  const tarballData = `published tarball ${packageName}@${version}`;
  const dist = {
    ...(normalizedOptions.includeTarballUrl === false
      ? {}
      : { tarball: tarballUrl }),
    ...(normalizedOptions.includeIntegrity === false
      ? {}
      : {
          integrity:
            normalizedOptions.integrity ?? createIntegrity(tarballData),
        }),
    ...(normalizedOptions.shasum === undefined
      ? {}
      : { shasum: normalizedOptions.shasum }),
  };
  const versions =
    normalizedOptions.versions ??
    ({
      [version]: {
        dist,
      },
    } satisfies Record<string, unknown>);

  packageCheckMocks.registryPackages.set(packageName, {
    'dist-tags': normalizedOptions.distTags ?? {
      latest: version,
    },
    versions,
  });

  if (normalizedOptions.registerTarball === false) {
    return;
  }

  packageCheckMocks.registryTarballs.set(tarballUrl, Buffer.from(tarballData));
  packageCheckMocks.packedTarballFiles.set(
    tarballData,
    createPublishedPackageFiles(packageName, version, {
      files: normalizedOptions.files,
      manifest: normalizedOptions.manifest,
    }),
  );
  packageCheckMocks.packedTarballManifests.set(tarballData, {
    name: packageName,
    version,
    ...normalizedOptions.manifest,
  });
}

function registerPackageMetadata(
  packageName: string,
  metadata: Record<string, unknown>,
): void {
  packageCheckMocks.registryPackages.set(packageName, metadata);
}

async function createWorkspaceDependencyReleaseFixture(): Promise<{
  outDir: string;
  rootDir: string;
}> {
  const rootDir = await createWorkspaceRoot();
  const outDir = await createWorkspacePackage(
    rootDir,
    '@example/a',
    {
      dependencies: {
        '@example/b': 'workspace:*',
      },
    },
    {
      dependencies: {
        '@example/b': '^1.0.0',
      },
    },
  );

  await createWorkspacePackage(rootDir, '@example/b', {
    version: '1.0.0',
  });

  return { outDir, rootDir };
}

function createConfig(
  rootDir: string,
  entries: NonNullable<NonNullable<ResolvedLiminaConfig['package']>['entries']>,
  options: {
    release?: ResolvedLiminaConfig['release'];
  } = {},
): ResolvedLiminaConfig {
  return {
    configPath: path.join(rootDir, 'limina.config.mjs'),
    package: {
      entries: entries.map((entry) => ({
        ...entry,
        outDir: path.isAbsolute(entry.outDir)
          ? path.relative(rootDir, entry.outDir)
          : entry.outDir,
      })),
    },
    release: options.release,
    rootDir,
  };
}

async function collectReleaseConsistencyFindings(options: {
  config: ResolvedLiminaConfig;
  label: string;
  outDir: string;
}): Promise<readonly ReleaseFinding[]> {
  const packedTarball = await packOutputTarball(options.outDir);
  const outputManifest = JSON.parse(
    await readFile(path.join(options.outDir, 'package.json'), 'utf8'),
  ) as Parameters<typeof assertPackageReleaseConsistency>[0]['outputManifest'];

  try {
    await assertPackageReleaseConsistency({
      config: options.config,
      label: options.label,
      outDir: options.outDir,
      outputManifest,
      packedTarball: packedTarball.tarball,
      packedTarballPath: packedTarball.tarballPath,
      workspacePackages: await collectRawWorkspacePackages(options.config),
    });
  } catch (error) {
    if (error instanceof PackageReleaseConsistencyError) {
      return error.findings;
    }

    throw error;
  } finally {
    await packedTarball.cleanup();
  }

  return [];
}

function createFlow(): {
  chunks: string[];
  flow: LiminaFlowReporter;
} {
  const chunks: string[] = [];

  return {
    chunks,
    flow: new LiminaFlowReporter({
      env: {
        CI: 'true',
      },
      forceTty: false,
      output: {
        write: (message) => {
          chunks.push(message);
        },
      },
      stdout: {
        isTTY: false,
      },
    }),
  };
}

function createGraphRejectingPreflight(
  config: ResolvedLiminaConfig,
  getGraph: () => Promise<never>,
): InstanceType<typeof LiminaPreflightManager> {
  return new LiminaPreflightManager({
    config,
    generatedGraphProvider: getGraph,
  });
}

beforeEach(() => {
  packageCheckMocks.attwCheckOptions = [];
  packageCheckMocks.attwProblems = [];
  packageCheckMocks.attwRuns = 0;
  packageCheckMocks.packedManifestOverrides.clear();
  packageCheckMocks.packedTarballFiles.clear();
  packageCheckMocks.packedTarballManifests.clear();
  packageCheckMocks.packCalls = [];
  packageCheckMocks.publintCalls = [];
  packageCheckMocks.publintMessages = [];
  packageCheckMocks.publintRenderedMessages.clear();
  packageCheckMocks.registryPackages.clear();
  packageCheckMocks.registryResponses.clear();
  packageCheckMocks.registryTarballs.clear();
  packageCheckMocks.unpackCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const urlString = String(url);
      const tarball = packageCheckMocks.registryTarballs.get(urlString);

      if (tarball) {
        return {
          arrayBuffer: async () => toArrayBuffer(tarball),
          ok: true,
          status: 200,
          statusText: 'OK',
        };
      }

      if (urlString.endsWith('.tgz')) {
        return {
          arrayBuffer: async () => toArrayBuffer(Buffer.from('')),
          ok: false,
          status: 404,
          statusText: 'Not Found',
        };
      }

      const packageName = decodeURIComponent(
        new URL(urlString).pathname.slice(1),
      );
      const configuredResponse =
        packageCheckMocks.registryResponses.get(packageName);

      if (configuredResponse) {
        if (configuredResponse.fetchError) {
          throw configuredResponse.fetchError;
        }

        return {
          json: async () => {
            if (configuredResponse.bodyError) {
              throw configuredResponse.bodyError;
            }

            if (configuredResponse.jsonError) {
              throw configuredResponse.jsonError;
            }

            return configuredResponse.body;
          },
          ok:
            configuredResponse.status >= 200 && configuredResponse.status < 300,
          status: configuredResponse.status,
          statusText: configuredResponse.statusText,
        };
      }

      const metadata = packageCheckMocks.registryPackages.get(packageName);

      if (!metadata) {
        return {
          json: async () => ({}),
          ok: false,
          status: 404,
          statusText: 'Not Found',
        };
      }

      return {
        json: async () => metadata,
        ok: true,
        status: 200,
        statusText: 'OK',
      };
    }),
  );
});

describe('typed Release finding producers', () => {
  it.each([
    {
      configField: 'release.contentHash.baselineTag',
      contentHash: { baselineTag: () => '' },
    },
    {
      configField: 'release.contentHash.ignore',
      contentHash: { ignore: () => [''] },
    },
  ] as const)(
    'emits $configField failures directly instead of classifying registry text',
    async ({ configField, contentHash }) => {
      const { outDir, rootDir } =
        await createWorkspaceDependencyReleaseFixture();
      registerPublishedPackage('@example/b', '1.0.0');
      const config = createConfig(rootDir, [{ name: '@example/a', outDir }], {
        release: { contentHash },
      });

      try {
        const findings = await collectReleaseConsistencyFindings({
          config,
          label: '@example/a',
          outDir,
        });

        expect(findings).toHaveLength(1);
        const finding = findings[0]!;
        expect(finding).toMatchObject({
          code: 'LIMINA_RELEASE_CONTENT_HASH',
          filePath: config.configPath,
          packageManifestPath: normalizeAbsolutePath(
            path.join(rootDir, 'packages/b/package.json'),
          ),
          packageName: '@example/b',
          reason: 'config-invalid',
          task: 'release:check',
        });
        expect(finding.code).not.toBe('LIMINA_RELEASE_REGISTRY');
        expect(finding.facts).toMatchObject({
          configField,
          dependencyName: '@example/b',
          importerName: '@example/a',
          kind: 'config-invalid',
        });
      } finally {
        await rm(rootDir, { force: true, recursive: true });
      }
    },
  );

  it('emits changed, local-only, and remote-only content hash facts with hashes', async () => {
    const { outDir, rootDir } = await createWorkspaceDependencyReleaseFixture();
    const dependencyOutDir = path.join(rootDir, 'packages/b/dist');
    await writeText(
      path.join(dependencyOutDir, 'index.js'),
      'export const value = 2;\n',
    );
    await writeText(
      path.join(dependencyOutDir, 'local-only.js'),
      'export const local = true;\n',
    );
    registerPublishedPackage('@example/b', '1.0.0', {
      files: {
        'remote-only.js': 'export const remote = true;\n',
      },
    });

    try {
      const findings = await collectReleaseConsistencyFindings({
        config: createConfig(rootDir, [{ name: '@example/a', outDir }]),
        label: '@example/a',
        outDir,
      });
      const finding = findings.find(
        (item) => item.code === 'LIMINA_RELEASE_CONTENT_HASH',
      );

      expect(finding).toBeDefined();
      expect(finding?.reason).toBe('content-diff');

      if (
        finding?.code !== 'LIMINA_RELEASE_CONTENT_HASH' ||
        finding.facts.kind !== 'content-diff'
      ) {
        throw new Error('expected a typed content-diff finding');
      }

      expect(finding.facts.diffs.map((diff) => diff.kind)).toEqual([
        'local-only',
        'remote-only',
        'changed',
      ]);
      expect(finding.facts.diffs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'changed',
            localHash: expect.stringMatching(/^[\da-f]{64}$/u),
            relativePath: 'index.js',
            remoteHash: expect.stringMatching(/^[\da-f]{64}$/u),
          }),
          expect.objectContaining({
            kind: 'local-only',
            localHash: expect.stringMatching(/^[\da-f]{64}$/u),
            relativePath: 'local-only.js',
          }),
          expect.objectContaining({
            kind: 'remote-only',
            relativePath: 'remote-only.js',
            remoteHash: expect.stringMatching(/^[\da-f]{64}$/u),
          }),
        ]),
      );
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it.each([
    {
      expectedReason: 'metadata-request',
      response: {
        fetchError: new Error('network unavailable'),
        status: 0,
        statusText: '',
      },
    },
    {
      expectedReason: 'metadata-invalid-json',
      response: {
        jsonError: new SyntaxError('invalid JSON'),
        status: 200,
        statusText: 'OK',
      },
    },
    {
      expectedReason: 'metadata-body-read',
      response: {
        bodyError: new Error('body interrupted'),
        status: 200,
        statusText: 'OK',
      },
    },
    {
      expectedReason: 'metadata-invalid-object',
      response: {
        body: [],
        status: 200,
        statusText: 'OK',
      },
    },
    {
      expectedReason: 'metadata-http-status',
      response: {
        status: 503,
        statusText: 'Service Unavailable',
      },
    },
  ])(
    'maps registry metadata failures to $expectedReason findings',
    async ({ expectedReason, response }) => {
      const { outDir, rootDir } =
        await createWorkspaceDependencyReleaseFixture();
      packageCheckMocks.registryResponses.set('@example/b', response);

      try {
        const findings = await collectReleaseConsistencyFindings({
          config: createConfig(rootDir, [{ name: '@example/a', outDir }]),
          label: '@example/a',
          outDir,
        });
        const finding = findings.find(
          (item) => item.code === 'LIMINA_RELEASE_REGISTRY',
        );

        expect(finding).toMatchObject({
          code: 'LIMINA_RELEASE_REGISTRY',
          packageName: '@example/b',
          reason: expectedReason,
          task: 'release:check',
        });
        expect(finding?.facts).toMatchObject({
          dependencyName: '@example/b',
          importerName: '@example/a',
          kind: expectedReason,
          registryUrl: 'https://registry.npmjs.org/%40example%2Fb',
        });
      } finally {
        await rm(rootDir, { force: true, recursive: true });
      }
    },
  );

  it('maps an aborted metadata request to a typed timeout finding', async () => {
    const { outDir, rootDir } = await createWorkspaceDependencyReleaseFixture();
    const controller = new AbortController();
    controller.abort(new Error('metadata timeout'));
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(controller.signal);
    packageCheckMocks.registryResponses.set('@example/b', {
      fetchError: new Error('metadata timeout'),
      status: 0,
      statusText: '',
    });

    try {
      const findings = await collectReleaseConsistencyFindings({
        config: createConfig(rootDir, [{ name: '@example/a', outDir }]),
        label: '@example/a',
        outDir,
      });
      const finding = findings.find(
        (item) => item.code === 'LIMINA_RELEASE_REGISTRY',
      );

      expect(finding).toMatchObject({
        code: 'LIMINA_RELEASE_REGISTRY',
        reason: 'metadata-timeout',
      });
      expect(finding?.facts).toMatchObject({
        kind: 'metadata-timeout',
        timeoutMs: 30_000,
      });
    } finally {
      timeoutSpy.mockRestore();
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it.each([
    {
      expectedReason: 'package-not-found',
      register: () => {},
    },
    {
      expectedReason: 'dist-tag-missing',
      register: () =>
        registerPackageMetadata('@example/b', {
          versions: {},
        }),
    },
    {
      expectedReason: 'version-missing',
      register: () =>
        registerPackageMetadata('@example/b', {
          'dist-tags': { latest: '1.0.0' },
          versions: {},
        }),
    },
    {
      expectedReason: 'tarball-url-missing',
      register: () =>
        registerPublishedPackage('@example/b', '1.0.0', {
          includeTarballUrl: false,
        }),
    },
    {
      expectedReason: 'integrity-missing',
      register: () =>
        registerPublishedPackage('@example/b', '1.0.0', {
          includeIntegrity: false,
        }),
    },
    {
      expectedReason: 'integrity-invalid',
      register: () =>
        registerPublishedPackage('@example/b', '1.0.0', {
          integrity: 'not-valid-sri',
        }),
    },
    {
      expectedReason: 'integrity-mismatch',
      register: () =>
        registerPublishedPackage('@example/b', '1.0.0', {
          integrity: createIntegrity('different tarball'),
        }),
    },
  ])(
    'maps registry artifact metadata to $expectedReason findings',
    async ({ expectedReason, register }) => {
      const { outDir, rootDir } =
        await createWorkspaceDependencyReleaseFixture();
      register();

      try {
        const findings = await collectReleaseConsistencyFindings({
          config: createConfig(rootDir, [{ name: '@example/a', outDir }]),
          label: '@example/a',
          outDir,
        });
        const finding = findings.find(
          (item) => item.code === 'LIMINA_RELEASE_REGISTRY',
        );

        expect(finding).toMatchObject({
          code: 'LIMINA_RELEASE_REGISTRY',
          reason: expectedReason,
          task: 'release:check',
        });
        expect(finding?.facts).toMatchObject({
          dependencyName: '@example/b',
          kind: expectedReason,
        });

        if (expectedReason === 'integrity-invalid') {
          expect(finding?.facts).toMatchObject({
            integrityField: 'integrity',
            registryIntegrity: 'not-valid-sri',
          });
        }

        if (expectedReason === 'integrity-mismatch') {
          expect(finding?.facts).toMatchObject({
            actualIntegrity: expect.stringMatching(/^sha512-/u),
            actualShasum: createShasum('published tarball @example/b@1.0.0'),
            expectedIntegrity: createIntegrity('different tarball'),
            integritySource: 'integrity',
            registryIntegrity: createIntegrity('different tarball'),
          });
        }
      } finally {
        await rm(rootDir, { force: true, recursive: true });
      }
    },
  );

  it('retains expected and actual shasum facts when registry shasum verification fails', async () => {
    const { outDir, rootDir } = await createWorkspaceDependencyReleaseFixture();
    const expectedShasum = createShasum('different tarball');
    const actualShasum = createShasum('published tarball @example/b@1.0.0');

    registerPublishedPackage('@example/b', '1.0.0', {
      includeIntegrity: false,
      shasum: expectedShasum,
    });

    try {
      const findings = await collectReleaseConsistencyFindings({
        config: createConfig(rootDir, [{ name: '@example/a', outDir }]),
        label: '@example/a',
        outDir,
      });
      const finding = findings.find(
        (item) => item.code === 'LIMINA_RELEASE_REGISTRY',
      );

      expect(finding).toMatchObject({
        code: 'LIMINA_RELEASE_REGISTRY',
        facts: {
          actualShasum,
          expectedShasum,
          integritySource: 'shasum',
          kind: 'integrity-mismatch',
          registryShasum: expectedShasum,
        },
        reason: 'integrity-mismatch',
      });
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it.each([
    'tarball-http-status',
    'tarball-request',
    'tarball-body-read',
    'tarball-timeout',
  ] as const)(
    'maps registry tarball failures to %s findings',
    async (expectedReason) => {
      const { outDir, rootDir } =
        await createWorkspaceDependencyReleaseFixture();
      const defaultFetch = vi.mocked(fetch).getMockImplementation()!;
      let timeoutSpy: ReturnType<typeof vi.spyOn> | undefined;

      registerPublishedPackage('@example/b', '1.0.0', {
        registerTarball: false,
      });

      if (expectedReason === 'tarball-timeout') {
        const controller = new AbortController();
        controller.abort(new Error('tarball timeout'));
        timeoutSpy = vi
          .spyOn(AbortSignal, 'timeout')
          .mockReturnValue(controller.signal);
      }

      vi.mocked(fetch).mockImplementation(async (input, init) => {
        if (!String(input).endsWith('.tgz')) {
          return defaultFetch(input, init);
        }

        if (expectedReason === 'tarball-http-status') {
          return {
            ok: false,
            status: 502,
            statusText: 'Bad Gateway',
          } as Response;
        }

        if (expectedReason === 'tarball-body-read') {
          return {
            arrayBuffer: async () => {
              throw new Error('tarball body interrupted');
            },
            ok: true,
            status: 200,
            statusText: 'OK',
          } as unknown as Response;
        }

        throw new Error(
          expectedReason === 'tarball-timeout'
            ? 'tarball timeout'
            : 'tarball request failed',
        );
      });

      try {
        const findings = await collectReleaseConsistencyFindings({
          config: createConfig(rootDir, [{ name: '@example/a', outDir }]),
          label: '@example/a',
          outDir,
        });
        const finding = findings.find(
          (item) => item.code === 'LIMINA_RELEASE_REGISTRY',
        );

        expect(finding).toMatchObject({
          code: 'LIMINA_RELEASE_REGISTRY',
          packageName: '@example/b',
          reason: expectedReason,
          task: 'release:check',
        });
        expect(finding?.facts).toMatchObject({
          dependencyName: '@example/b',
          kind: expectedReason,
          requestedVersion: '1.0.0',
          tarballUrl:
            'https://registry.npmjs.org/%40example%2Fb/-/example-b-1.0.0.tgz',
        });
      } finally {
        timeoutSpy?.mockRestore();
        await rm(rootDir, { force: true, recursive: true });
      }
    },
  );

  it('emits typed packed-manifest facts for private dependencies and range mismatches', async () => {
    const privateRootDir = await createWorkspaceRoot();
    const rangeRootDir = await createWorkspaceRoot();

    try {
      const privateOutDir = await createWorkspacePackage(
        privateRootDir,
        '@example/a',
        { dependencies: { '@example/b': 'workspace:*' } },
        { dependencies: { '@example/b': '^1.0.0' } },
      );
      await createWorkspacePackage(privateRootDir, '@example/b', {
        private: true,
      });
      const privateFindings = await collectReleaseConsistencyFindings({
        config: createConfig(privateRootDir, [
          { name: '@example/a', outDir: privateOutDir },
        ]),
        label: '@example/a',
        outDir: privateOutDir,
      });

      expect(privateFindings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'LIMINA_RELEASE_PACKED_MANIFEST',
            facts: expect.objectContaining({
              dependencyName: '@example/b',
              kind: 'source-private-dependency',
              targetManifestPath: normalizeAbsolutePath(
                path.join(privateRootDir, 'packages/b/package.json'),
              ),
            }),
          }),
        ]),
      );

      const rangeOutDir = await createWorkspacePackage(
        rangeRootDir,
        '@example/a',
        { dependencies: { '@example/b': 'workspace:*' } },
        { dependencies: { '@example/b': '^2.0.0' } },
      );
      await createWorkspacePackage(rangeRootDir, '@example/b', {
        version: '1.0.0',
      });
      registerPublishedPackage('@example/b', '1.0.0');
      const rangeFindings = await collectReleaseConsistencyFindings({
        config: createConfig(rangeRootDir, [
          { name: '@example/a', outDir: rangeOutDir },
        ]),
        label: '@example/a',
        outDir: rangeOutDir,
      });

      expect(rangeFindings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'LIMINA_RELEASE_PACKED_MANIFEST',
            facts: expect.objectContaining({
              actualRange: '^2.0.0',
              dependencyName: '@example/b',
              expectedVersion: '1.0.0',
              kind: 'packed-dependency-range-mismatch',
            }),
          }),
        ]),
      );
    } finally {
      await rm(privateRootDir, { force: true, recursive: true });
      await rm(rangeRootDir, { force: true, recursive: true });
    }
  });

  it('emits packed-dependency-missing facts from the packed manifest producer', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(
        rootDir,
        '@example/a',
        { dependencies: { '@example/b': 'workspace:*' } },
        { dependencies: {} },
      );
      await createWorkspacePackage(rootDir, '@example/b', {
        version: '1.0.0',
      });
      registerPublishedPackage('@example/b', '1.0.0');

      const findings = await collectReleaseConsistencyFindings({
        config: createConfig(rootDir, [{ name: '@example/a', outDir }]),
        label: '@example/a',
        outDir,
      });

      expect(findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'LIMINA_RELEASE_PACKED_MANIFEST',
            facts: expect.objectContaining({
              dependencyName: '@example/b',
              kind: 'packed-dependency-missing',
              packedManifestPath: 'package.tgz#package.json',
              sectionName: 'dependencies',
            }),
          }),
        ]),
      );
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('adapts command-owned output-manifest and private-output findings without parsing text', async () => {
    const localRootDir = await createWorkspaceRoot();
    const privateRootDir = await createWorkspaceRoot();

    try {
      const localOutDir = await createWorkspacePackage(
        localRootDir,
        '@example/a',
        {},
        { devDependencies: { '@example/dev': 'file:../dev' } },
      );
      const localIssues: LiminaCheckIssue[] = [];
      await expect(
        runReleaseCheck({
          config: createConfig(localRootDir, [
            { name: '@example/a', outDir: localOutDir },
          ]),
          deferSnapshot: true,
          issues: localIssues,
          packageNames: ['@example/a'],
          report: { defer: true },
        }),
      ).resolves.toBe(false);
      expect(localIssues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'LIMINA_RELEASE_PACKED_MANIFEST',
            filePath: 'packages/a/dist/package.json',
            packageManifestPath: 'packages/a/dist/package.json',
            packageName: '@example/a',
            task: 'release:check',
          }),
        ]),
      );
      expect(
        localIssues.every(
          (issue) => issue.code === 'LIMINA_RELEASE_PACKED_MANIFEST',
        ),
      ).toBe(true);

      const privateOutDir = await createWorkspacePackage(
        privateRootDir,
        '@example/a',
        {},
        { private: true },
      );
      const privateIssues: LiminaCheckIssue[] = [];
      await expect(
        runReleaseCheck({
          config: createConfig(privateRootDir, [
            { name: '@example/a', outDir: privateOutDir },
          ]),
          deferSnapshot: true,
          issues: privateIssues,
          packageNames: ['@example/a'],
          report: { defer: true },
        }),
      ).resolves.toBe(false);
      expect(privateIssues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'LIMINA_RELEASE_TARBALL_HYGIENE',
            filePath: 'packages/a/dist/package.json',
            packageManifestPath: 'packages/a/dist/package.json',
            packageName: '@example/a',
            task: 'release:check',
          }),
        ]),
      );
      expect(
        privateIssues.every(
          (issue) => issue.code === 'LIMINA_RELEASE_TARBALL_HYGIENE',
        ),
      ).toBe(true);
    } finally {
      await rm(localRootDir, { force: true, recursive: true });
      await rm(privateRootDir, { force: true, recursive: true });
    }
  });

  it('emits packed-manifest and tarball-hygiene facts from their detectors', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(rootDir, '@example/a', {});
      packageCheckMocks.packedManifestOverrides.set(outDir, {
        devDependencies: { '@example/dev': 'file:../dev' },
        name: '@example/a',
        version: '1.0.0',
      });
      await rm(path.join(outDir, 'README.md'), { force: true });
      await writeText(path.join(outDir, 'index.js.map'), '{}\n');
      await writeText(
        path.join(outDir, 'mapped.js'),
        'export const mapped = true;\n//# sourceMappingURL=mapped.js.map\n',
      );

      const findings = await collectReleaseConsistencyFindings({
        config: createConfig(rootDir, [{ name: '@example/a', outDir }], {
          release: { npmPackageJsonLint: true },
        }),
        label: '@example/a',
        outDir,
      });

      expect(findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'LIMINA_RELEASE_PACKED_MANIFEST',
            facts: expect.objectContaining({
              dependencyName: '@example/dev',
              kind: 'packed-local-specifier',
              sectionName: 'devDependencies',
              specifier: 'file:../dev',
            }),
          }),
          expect.objectContaining({
            code: 'LIMINA_RELEASE_PACKED_MANIFEST',
            external: expect.objectContaining({
              code: expect.any(String),
              tool: 'npm-package-json-lint',
            }),
            facts: expect.objectContaining({
              kind: 'manifest-lint-failed',
              lintRule: expect.any(String),
            }),
          }),
          expect.objectContaining({
            code: 'LIMINA_RELEASE_TARBALL_HYGIENE',
            facts: expect.objectContaining({
              kind: 'required-files-missing',
              missingFiles: ['README.md'],
            }),
          }),
          expect.objectContaining({
            code: 'LIMINA_RELEASE_TARBALL_HYGIENE',
            facts: expect.objectContaining({
              archiveEntryPath: 'index.js.map',
              kind: 'source-map-file',
            }),
          }),
          expect.objectContaining({
            code: 'LIMINA_RELEASE_TARBALL_HYGIENE',
            facts: expect.objectContaining({
              archiveEntryPath: 'mapped.js',
              kind: 'source-mapping-url',
            }),
          }),
        ]),
      );
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });
});

describe('auditPublishedPackageBoundaries', () => {
  it('allows self exports, declared dependencies, relative imports, and node builtins in node output', async () => {
    const pkg = await createOutputPackage(
      {
        'index.js': "import '@example/dep';\nimport './local.js';\n",
        'local.js': 'export const value = 1;\n',
        'node/index.js': "import 'node:fs';\nexport const value = 1;\n",
        'self.js': "import '@example/pkg/feature';\n",
      },
      {
        exports: {
          '.': './index.js',
          './feature': './self.js',
        },
      },
    );

    try {
      await expect(
        auditPublishedPackageBoundaries({
          outDir: pkg.outDir,
        }),
      ).resolves.toEqual([]);
    } finally {
      await pkg.cleanup();
    }
  });

  it('reports browser node builtins, undeclared dependencies, and unexported self imports', async () => {
    const pkg = await createOutputPackage({
      'index.js':
        "import 'node:fs';\nimport '@example/missing';\nimport '@example/pkg/private';\n",
    });

    try {
      const violations = await auditPublishedPackageBoundaries({
        outDir: pkg.outDir,
      });

      expect(violations.map((violation) => violation.specifier)).toEqual([
        '@example/missing',
        '@example/pkg/private',
        'node:fs',
      ]);
    } finally {
      await pkg.cleanup();
    }
  });

  it('validates exact, pattern, conditional, builtin, local, and dependency package imports from the published manifest', async () => {
    const pkg = await createOutputPackage(
      {
        'browser.js': 'export const browser = true;\n',
        'default.js': 'export const fallback = true;\n',
        'features/a.js': 'export const feature = true;\n',
        'index.js': [
          "import '#exact';",
          "import '#features/a';",
          "import '#unknown';",
          "import '#blocked';",
          "import '#escape';",
          "import '#dependency';",
          "import '#missing-dependency';",
          "import '#conditional';",
          "import '#conditional-bad';",
          "import '@example/dep';",
          "import '@example/direct-missing';",
        ].join('\n'),
        'internal.js': 'export const internal = true;\n',
        'node/index.js': "import '#builtin';\n",
      },
      {
        imports: {
          '#blocked': null,
          '#builtin': 'node:fs',
          '#conditional': {
            browser: './browser.js',
            default: './default.js',
          },
          '#conditional-bad': {
            default: './default.js',
            node: '@example/undeclared-conditional',
          },
          '#dependency': '@example/dep',
          '#escape': '../outside.js',
          '#exact': './internal.js',
          '#features/*': './features/*.js',
          '#missing-dependency': '@example/missing',
        },
      },
    );

    try {
      const violations = await auditPublishedPackageBoundaries({
        outDir: pkg.outDir,
      });

      expect(violations.map((violation) => violation.specifier)).toEqual([
        '@example/direct-missing',
        '#blocked',
        '#conditional-bad',
        '#escape',
        '#missing-dependency',
        '#unknown',
      ]);
    } finally {
      await pkg.cleanup();
    }
  });
});

describe('runPackageCheck and runReleaseCheck', () => {
  it('records package boundary file paths relative to the config root', async () => {
    const rootDir = await createWorkspaceRoot();
    const outDir = path.join(rootDir, 'packages/pkg/dist');
    const issues: LiminaCheckIssue[] = [];

    try {
      await writeText(
        path.join(outDir, 'package.json'),
        JSON.stringify({
          exports: { '.': './browser/index.js' },
          name: '@example/pkg',
          version: '1.0.0',
        }),
      );
      await writeText(
        path.join(outDir, 'browser/index.js'),
        "import '@example/undeclared';\n",
      );

      await expect(
        runPackageCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              name: '@example/pkg',
              outDir: 'packages/pkg/dist',
            },
          ]),
          deferSnapshot: true,
          issues,
          tool: 'boundary',
        }),
      ).resolves.toBe(false);

      expect(issues).toContainEqual(
        expect.objectContaining({
          filePath: 'packages/pkg/dist/browser/index.js',
          locations: expect.arrayContaining([
            {
              filePath: 'packages/pkg/dist/browser/index.js',
            },
          ]),
        }),
      );

      const snapshot = {
        command: 'limina check',
        createdAt: '2026-07-17T00:00:00.000Z',
        issues,
        status: 'completed' as const,
        version: 7 as const,
      };
      const byFile = JSON.parse(
        formatCheckIssueSnapshotInventory({
          filters: { files: ['packages/pkg/dist/browser/index.js'] },
          format: 'json',
          rootDir,
          snapshot,
        }),
      ) as { issueCount: number };
      const byScope = JSON.parse(
        formatCheckIssueSnapshotInventory({
          filters: { scopes: ['packages/pkg/dist/browser/**'] },
          format: 'json',
          rootDir,
          snapshot,
        }),
      ) as { issueCount: number };
      const ndjson = formatCheckIssueSnapshotInventory({
        filters: { scopes: ['packages/pkg/dist/browser'] },
        format: 'ndjson',
        rootDir,
        snapshot,
      });

      expect(byFile.issueCount).toBe(1);
      expect(byScope.issueCount).toBe(1);
      expect(JSON.parse(ndjson)).toMatchObject({
        filePath: 'packages/pkg/dist/browser/index.js',
      });
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('reports package entry and sub-check states to the flow reporter', async () => {
    const pkg = await createOutputPackage({
      'index.js': "import '@example/dep';\n",
    });
    const rootDir = await createWorkspaceRoot();
    const { chunks, flow } = createFlow();
    let stats: LiminaCheckRunTaskStats | undefined;

    try {
      await expect(
        runPackageCheck({
          clearScreen: false,
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              outDir: pkg.outDir,
              name: '@example/valid',
            },
          ]),
          flow,
          onStats: (nextStats) => {
            stats = nextStats;
          },
        }),
      ).resolves.toBe(true);

      expect(
        chunks.some((chunk) => chunk.includes('[start] package check')),
      ).toBe(true);
      expect(
        chunks.some((chunk) =>
          chunk.includes('[start] package entry: @example/valid'),
        ),
      ).toBe(true);
      expect(
        chunks.some((chunk) =>
          chunk.includes('[pass] package boundary: @example/valid'),
        ),
      ).toBe(true);
      expect(stats).toMatchObject({
        items: [
          {
            name: '@example/valid (boundary)',
            status: 'passed',
          },
        ],
        passed: 1,
        total: 1,
      });
    } finally {
      await pkg.cleanup();
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('does not read generated graph during package checks', async () => {
    const pkg = await createOutputPackage({
      'index.js': "import '@example/dep';\n",
    });
    const rootDir = await createWorkspaceRoot();
    const config = createConfig(rootDir, [
      {
        checks: ['boundary'],
        name: '@example/valid',
        outDir: pkg.outDir,
      },
    ]);
    const getGraph = vi.fn(async () => {
      throw new Error('package check should not read generated graph');
    });

    try {
      await expect(
        runPackageCheck({
          clearScreen: false,
          config,
          preflight: createGraphRejectingPreflight(config, getGraph),
        }),
      ).resolves.toBe(true);

      expect(getGraph).not.toHaveBeenCalled();
    } finally {
      await pkg.cleanup();
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('does not read generated graph during release checks', async () => {
    const rootDir = await createWorkspaceRoot();
    const outDir = await createWorkspacePackage(rootDir, '@example/a', {});
    const config = createConfig(rootDir, [
      {
        checks: ['boundary'],
        name: '@example/a',
        outDir,
      },
    ]);
    const getGraph = vi.fn(async () => {
      throw new Error('release check should not read generated graph');
    });
    let stats: LiminaCheckRunTaskStats | undefined;

    try {
      await expect(
        runReleaseCheck({
          clearScreen: false,
          config,
          onStats: (nextStats) => {
            stats = nextStats;
          },
          packageNames: ['@example/a'],
          preflight: createGraphRejectingPreflight(config, getGraph),
        }),
      ).resolves.toBe(true);

      expect(getGraph).not.toHaveBeenCalled();
      expect(stats).toMatchObject({
        items: [
          {
            name: '@example/a',
            status: 'passed',
          },
        ],
        passed: 1,
        total: 1,
      });
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('reuses the preflight activated package index for release consistency', async () => {
    const rootDir = await createWorkspaceRoot();
    const outDir = await createWorkspacePackage(
      rootDir,
      '@example/a',
      {
        dependencies: {
          '@example/b': 'workspace:*',
        },
      },
      {
        dependencies: {
          '@example/b': '^1.0.0',
        },
      },
    );
    await createWorkspacePackage(rootDir, '@example/b', {});
    const config = createConfig(rootDir, [
      {
        checks: ['boundary'],
        name: '@example/a',
        outDir,
      },
    ]);
    const preflight = createGraphRejectingPreflight(config, async () => {
      throw new Error('release check should not read generated graph');
    });
    const activatedPackages = await preflight.ensureWorkspacePackages();
    vi.spyOn(preflight, 'ensureWorkspacePackages').mockResolvedValue(
      activatedPackages.map((workspacePackage) =>
        workspacePackage.name === '@example/b'
          ? {
              ...workspacePackage,
              manifest: { ...workspacePackage.manifest, private: true },
            }
          : workspacePackage,
      ),
    );
    const errorSpy = vi
      .spyOn(ReleaseLogger, 'error')
      .mockImplementation(() => {});

    try {
      await expect(
        runReleaseCheck({
          clearScreen: false,
          config,
          packageNames: ['@example/a'],
          preflight,
        }),
      ).resolves.toBe(false);

      expect(errorSpy.mock.calls.join('\n')).toContain(
        '@example/a -> @example/b [dependencies] (workspace:*): publishable packages cannot depend on a private workspace package',
      );
    } finally {
      errorSpy.mockRestore();
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('fails before metadata checks when the output package.json is missing', async () => {
    const rootDir = await createWorkspaceRoot();
    const outDir = path.join(rootDir, 'output', 'missing');

    try {
      await expect(
        runPackageCheck({
          config: createConfig(rootDir, [
            {
              outDir,
              name: '@example/pkg',
            },
          ]),
        }),
      ).resolves.toBe(false);

      expect(packageCheckMocks.packCalls).toEqual([]);
      expect(packageCheckMocks.publintCalls).toHaveLength(0);
      expect(packageCheckMocks.attwRuns).toBe(0);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('rejects output package manifests without names', async () => {
    const pkg = await createOutputPackage(
      {
        'index.js': 'export const value = 1;\n',
      },
      {
        name: '',
      },
    );

    try {
      await expect(
        runPackageCheck({
          config: createConfig(pkg.rootDir, [
            {
              checks: ['boundary'],
              outDir: pkg.outDir,
              name: '@example/pkg',
            },
          ]),
        }),
      ).resolves.toBe(false);

      expect(packageCheckMocks.packCalls).toEqual([]);
    } finally {
      await pkg.cleanup();
    }
  });

  it('does not run release metadata validation during package checks', async () => {
    const pkg = await createOutputPackage(
      {
        'index.js': "import '@example/dep';\n",
      },
      {},
      {
        includePublicMetadata: false,
      },
    );

    try {
      await expect(
        runPackageCheck({
          config: createConfig(pkg.rootDir, [
            {
              outDir: pkg.outDir,
              name: '@example/pkg',
            },
          ]),
        }),
      ).resolves.toBe(true);

      expect(packageCheckMocks.packCalls).toEqual([pkg.outDir]);
      expect(packageCheckMocks.publintCalls).toHaveLength(1);
      expect(packageCheckMocks.attwRuns).toBe(1);
    } finally {
      await pkg.cleanup();
    }
  });

  it('does not treat private package outputs as package check release failures', async () => {
    const pkg = await createOutputPackage(
      {
        'index.js': "import '@example/dep';\n",
      },
      {
        private: true,
      },
      {
        includePublicMetadata: false,
      },
    );

    try {
      await expect(
        runPackageCheck({
          config: createConfig(pkg.rootDir, [
            {
              checks: ['boundary'],
              outDir: pkg.outDir,
              name: '@example/pkg',
            },
          ]),
        }),
      ).resolves.toBe(true);
    } finally {
      await pkg.cleanup();
    }
  });

  it('rejects pnpm-local output manifest dependency specifiers', async () => {
    const pkg = await createOutputPackage(
      {
        'index.js': 'export const value = 1;\n',
      },
      {
        devDependencies: {
          '@example/dev': 'catalog:dev',
        },
      },
    );

    try {
      await expect(
        runPackageCheck({
          config: createConfig(pkg.rootDir, [
            {
              checks: ['boundary'],
              name: '@example/pkg',
              outDir: pkg.outDir,
            },
          ]),
        }),
      ).resolves.toBe(false);
    } finally {
      await pkg.cleanup();
    }
  });

  it('runs a single selected package tool without release metadata validation', async () => {
    const pkg = await createOutputPackage(
      {
        'index.js': "import '@example/dep';\n",
      },
      {},
      {
        includePublicMetadata: false,
      },
    );

    try {
      await expect(
        runPackageCheck({
          config: createConfig(pkg.rootDir, [
            {
              outDir: pkg.outDir,
              name: '@example/pkg',
            },
          ]),
          tool: 'publint',
        }),
      ).resolves.toBe(true);

      expect(packageCheckMocks.packCalls).toEqual([pkg.outDir]);
      expect(packageCheckMocks.publintCalls).toHaveLength(1);
      expect(packageCheckMocks.attwRuns).toBe(0);
    } finally {
      await pkg.cleanup();
    }
  });

  it('fails when a publishable package depends on a private workspace package', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(
        rootDir,
        '@example/a',
        {
          dependencies: {
            '@example/b': 'workspace:*',
          },
        },
        {
          dependencies: {
            '@example/b': '^1.0.0',
          },
        },
      );

      await createWorkspacePackage(rootDir, '@example/b', {
        private: true,
      });

      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              name: '@example/a',
              outDir,
            },
          ]),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(false);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('allows unrelated nameless workspace packages during release checks', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(rootDir, '@example/a', {});

      await writeText(
        path.join(rootDir, 'packages/fixture/package.json'),
        JSON.stringify({
          private: true,
        }),
      );
      await writeText(
        path.join(rootDir, 'packages/fixture/src/index.ts'),
        'export const fixtureValue = 1;\n',
      );

      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              name: '@example/a',
              outDir,
            },
          ]),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(true);

      expect(packageCheckMocks.packCalls).toEqual([outDir]);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('fails when a publishable source manifest uses link in publish dependencies', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(
        rootDir,
        '@example/a',
        {
          dependencies: {
            '@example/b': 'link:../b/dist',
          },
        },
        {
          dependencies: {
            '@example/b': '^1.0.0',
          },
        },
      );

      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              name: '@example/a',
              outDir,
            },
          ]),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(false);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('fails release checks for private package outputs', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(
        rootDir,
        '@example/a',
        {
          dependencies: {
            '@example/b': 'link:../b/dist',
          },
        },
        {
          private: true,
        },
      );

      await rm(path.join(outDir, 'README.md'), {
        force: true,
      });
      await rm(path.join(outDir, 'LICENSE.md'), {
        force: true,
      });

      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              name: '@example/a',
              outDir,
            },
          ]),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(false);

      expect(packageCheckMocks.packCalls).toEqual([]);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('fails release checks when the tarball is missing README.md or LICENSE.md', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(rootDir, '@example/a', {});

      await rm(path.join(outDir, 'README.md'), {
        force: true,
      });
      await rm(path.join(outDir, 'LICENSE.md'), {
        force: true,
      });

      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              name: '@example/a',
              outDir,
            },
          ]),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(false);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('fails release checks when the tarball contains source map files', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(rootDir, '@example/a', {});

      await writeText(path.join(outDir, 'index.js.map'), '{}\n');

      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              name: '@example/a',
              outDir,
            },
          ]),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(false);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('fails release checks when JavaScript has line sourceMappingURL comments', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(rootDir, '@example/a', {});

      await writeText(
        path.join(outDir, 'index.js'),
        'export const value = 1;\n//# sourceMappingURL=index.js.map\n',
      );

      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              name: '@example/a',
              outDir,
            },
          ]),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(false);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('fails release checks when JavaScript has block sourceMappingURL comments', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(rootDir, '@example/a', {});

      await writeText(
        path.join(outDir, 'index.mjs'),
        'export const value = 1;\n/*# sourceMappingURL=index.mjs.map */\n',
      );

      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              name: '@example/a',
              outDir,
            },
          ]),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(false);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('allows sourceMappingURL text in JavaScript literals', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(rootDir, '@example/a', {});

      await writeText(
        path.join(outDir, 'index.cjs'),
        [
          "const line = '//# sourceMappingURL=line.js.map';",
          'const block = "/*# sourceMappingURL=block.js.map */";',
          'const template = `\\n//# sourceMappingURL=template.js.map`;',
          'const regexp = /\\/\\/# sourceMappingURL=regexp\\.js\\.map/;',
          'module.exports = { block, line, regexp, template };',
          '',
        ].join('\n'),
      );

      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              name: '@example/a',
              outDir,
            },
          ]),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(true);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('does not run npm-package-json-lint when the release integration is omitted', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(rootDir, '@example/a', {});

      packageCheckMocks.packedManifestOverrides.set(outDir, {
        dependencies: {},
        exports: {
          '.': './index.js',
        },
        name: '@example/a',
        version: '1.0.0',
      });

      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              name: '@example/a',
              outDir,
            },
          ]),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(true);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('fails release checks when the enabled npm-package-json-lint defaults find a problem', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(rootDir, '@example/a', {});

      packageCheckMocks.packedManifestOverrides.set(outDir, {
        dependencies: {},
        exports: {
          '.': './index.js',
        },
        name: '@example/a',
        version: '1.0.0',
      });

      await expect(
        runReleaseCheck({
          config: createConfig(
            rootDir,
            [
              {
                name: '@example/a',
                outDir,
              },
            ],
            {
              release: {
                npmPackageJsonLint: true,
              },
            },
          ),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(false);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('merges npm-package-json-lint rule overrides over Limina defaults', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(rootDir, '@example/a', {});

      packageCheckMocks.packedManifestOverrides.set(outDir, {
        dependencies: {},
        exports: {
          '.': './index.js',
        },
        license: 'MIT',
        name: '@example/a',
        version: '1.0.0',
      });

      await expect(
        runReleaseCheck({
          config: createConfig(
            rootDir,
            [
              {
                name: '@example/a',
                outDir,
              },
            ],
            {
              release: {
                npmPackageJsonLint: {
                  rules: {
                    'require-types': 'off',
                  },
                },
              },
            },
          ),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(true);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('lints the packed manifest instead of the output manifest', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(rootDir, '@example/a', {});

      await writeText(
        path.join(outDir, 'package.json'),
        JSON.stringify({
          dependencies: {},
          exports: {
            '.': './index.js',
          },
          name: '@example/a',
          version: '1.0.0',
        }),
      );
      packageCheckMocks.packedManifestOverrides.set(outDir, {
        dependencies: {},
        exports: {
          '.': './index.js',
        },
        license: 'MIT',
        name: '@example/a',
        types: './index.d.ts',
        version: '1.0.0',
      });

      await expect(
        runReleaseCheck({
          config: createConfig(
            rootDir,
            [
              {
                name: '@example/a',
                outDir,
              },
            ],
            {
              release: {
                npmPackageJsonLint: true,
              },
            },
          ),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(true);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('accepts source manifests that expose source entries while release manifests expose artifacts', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(
        rootDir,
        '@example/a',
        {
          exports: {
            '.': './src/index.ts',
            './feature': './src/feature.ts',
          },
          types: './src/index.ts',
        },
        {
          exports: {
            '.': './index.js',
            './feature': './feature.js',
          },
          types: './index.d.ts',
        },
      );

      await writeText(
        path.join(rootDir, 'packages/a/src/feature.ts'),
        'export const feature = 1;\n',
      );
      await writeText(
        path.join(outDir, 'index.d.ts'),
        'export declare const value: number;\n',
      );
      await writeText(
        path.join(outDir, 'feature.js'),
        'export const feature = 1;\n',
      );

      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              name: '@example/a',
              outDir,
            },
          ]),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(true);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('ignores workspace and link specifiers in source devDependencies', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(
        rootDir,
        '@example/a',
        {
          devDependencies: {
            '@example/b': 'workspace:*',
            '@example/c': 'link:../c/dist',
          },
        },
        {},
      );

      await createWorkspacePackage(rootDir, '@example/b', {
        private: true,
      });

      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              name: '@example/a',
              outDir,
            },
          ]),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(true);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('fails when the packed manifest leaks workspace or link specifiers', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(
        rootDir,
        '@example/a',
        {
          dependencies: {
            '@example/b': 'workspace:*',
          },
        },
        {
          dependencies: {
            '@example/b': 'workspace:*',
            '@example/c': 'link:../c/dist',
          },
        },
      );

      await createWorkspacePackage(rootDir, '@example/b', {
        version: '1.0.0',
      });
      registerPublishedPackage('@example/b', '1.0.0');

      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              name: '@example/a',
              outDir,
            },
          ]),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(false);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('fails release checks when the packed manifest leaks local specifiers in devDependencies', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(rootDir, '@example/a', {});

      packageCheckMocks.packedManifestOverrides.set(outDir, {
        devDependencies: {
          '@example/dev': 'file:../dev',
        },
        exports: {
          '.': './index.js',
        },
        license: 'MIT',
        name: '@example/a',
        types: './index.d.ts',
        version: '1.0.0',
      });

      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              name: '@example/a',
              outDir,
            },
          ]),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(false);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('fails when a workspace dependency version is not published', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(
        rootDir,
        '@example/a',
        {
          dependencies: {
            '@example/b': 'workspace:*',
          },
        },
        {
          dependencies: {
            '@example/b': '^1.0.0',
          },
        },
      );

      await createWorkspacePackage(rootDir, '@example/b', {
        version: '1.0.0',
      });

      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              name: '@example/a',
              outDir,
            },
          ]),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(false);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('passes when workspace dependency source changes do not change packed package output', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(
        rootDir,
        '@example/a',
        {
          dependencies: {
            '@example/b': 'workspace:*',
          },
        },
        {
          dependencies: {
            '@example/b': '^1.0.0',
          },
        },
      );

      await createWorkspacePackage(rootDir, '@example/b', {
        version: '1.0.0',
      });
      await writeText(
        path.join(rootDir, 'packages/b/src/index.ts'),
        'export const sourceOnly = 2;\n',
      );
      registerPublishedPackage('@example/b', '1.0.0');

      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              name: '@example/a',
              outDir,
            },
          ]),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(true);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('uses the configured release contentHash dist-tag baseline', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(
        rootDir,
        '@example/a',
        {
          dependencies: {
            '@example/b': 'workspace:*',
          },
        },
        {
          dependencies: {
            '@example/b': '^1.0.0',
          },
        },
      );

      await createWorkspacePackage(rootDir, '@example/b', {
        version: '1.1.0',
      });
      registerPublishedPackage('@example/b', '1.1.0', {
        distTags: {
          beta: '1.1.0',
        },
      });

      await expect(
        runReleaseCheck({
          config: createConfig(
            rootDir,
            [
              {
                checks: ['boundary'],
                name: '@example/a',
                outDir,
              },
            ],
            {
              release: {
                contentHash: {
                  baselineTag: 'beta',
                },
              },
            },
          ),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(true);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('passes ignored dependency bundle differences and calls ignore with release context', async () => {
    const rootDir = await createWorkspaceRoot();
    const ignore = vi.fn(
      (args: { dependencyName: string; importerName: string }) =>
        args.importerName === '@example/a' &&
        args.dependencyName === '@example/b'
          ? ['client/**']
          : [],
    );

    try {
      const outDir = await createWorkspacePackage(
        rootDir,
        '@example/a',
        {
          dependencies: {
            '@example/b': 'workspace:*',
          },
        },
        {
          dependencies: {
            '@example/b': '^1.0.0',
          },
        },
      );
      const dependencyOutDir = await createWorkspacePackage(
        rootDir,
        '@example/b',
        {
          version: '1.0.0',
        },
      );

      await writeText(
        path.join(dependencyOutDir, 'client/runtime.js'),
        'export const runtime = "local";\n',
      );
      registerPublishedPackage('@example/b', '1.0.0', {
        files: {
          'client/runtime.js': 'export const runtime = "remote";\n',
        },
      });

      await expect(
        runReleaseCheck({
          config: createConfig(
            rootDir,
            [
              {
                checks: ['boundary'],
                name: '@example/a',
                outDir,
              },
            ],
            {
              release: {
                contentHash: {
                  ignore,
                },
              },
            },
          ),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(true);

      expect(ignore).toHaveBeenCalledWith({
        dependencyName: '@example/b',
        importerName: '@example/a',
      });
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('prints the baseline version and ignored contentHash diff counts', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(
        rootDir,
        '@example/a',
        {
          dependencies: {
            '@example/b': 'workspace:*',
          },
        },
        {
          dependencies: {
            '@example/b': '^1.0.0',
          },
        },
      );
      const dependencyOutDir = await createWorkspacePackage(
        rootDir,
        '@example/b',
        {
          version: '1.0.0',
        },
      );

      await writeText(
        path.join(dependencyOutDir, 'ignored/local-only.js'),
        'export const side = "local";\n',
      );
      await writeText(
        path.join(dependencyOutDir, 'ignored/changed.js'),
        'export const side = "local";\n',
      );
      registerPublishedPackage('@example/b', '1.0.0', {
        files: {
          'ignored/changed.js': 'export const side = "remote";\n',
          'ignored/remote-only.js': 'export const side = "remote";\n',
        },
      });

      await expect(
        runReleaseCheck({
          config: createConfig(
            rootDir,
            [
              {
                checks: ['boundary'],
                name: '@example/a',
                outDir,
              },
            ],
            {
              release: {
                contentHash: {
                  ignore: ['ignored/**'],
                },
              },
            },
          ),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(true);

      const output = stripAnsi(
        logSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n'),
      );

      expect(output).toContain('[release-check] PASS @example/a -> @example/b');
      expect(output).toContain('Baseline: npm latest -> @example/b@1.0.0');
      expect(output).toContain('Local: @example/b@1.0.0');
      expect(output).toContain('Ignored contentHash diffs:');
      expect(output).toContain('user "ignored/**":');
      expect(output).toContain('local-only: 1');
      expect(output).toContain('remote-only: 1');
      expect(output).toContain('changed: 1');
    } finally {
      logSpy.mockRestore();
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('does not ignore dependency README, docs, and examples by default', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(
        rootDir,
        '@example/a',
        {
          dependencies: {
            '@example/b': 'workspace:*',
          },
        },
        {
          dependencies: {
            '@example/b': '^1.0.0',
          },
        },
      );
      const dependencyOutDir = await createWorkspacePackage(
        rootDir,
        '@example/b',
        {
          version: '1.0.0',
        },
      );

      await writeText(path.join(dependencyOutDir, 'README.md'), '# New docs\n');
      await writeText(
        path.join(dependencyOutDir, 'docs/guide.md'),
        '# Guide\n',
      );
      await writeText(
        path.join(dependencyOutDir, 'examples/basic.js'),
        'export const example = true;\n',
      );
      registerPublishedPackage('@example/b', '1.0.0');

      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              name: '@example/a',
              outDir,
            },
          ]),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(false);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('uses builtin contentHash ignores when builtinIgnore is enabled without a user ignore', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(
        rootDir,
        '@example/a',
        {
          dependencies: {
            '@example/b': 'workspace:*',
          },
        },
        {
          dependencies: {
            '@example/b': '^1.0.0',
          },
        },
      );
      const dependencyOutDir = await createWorkspacePackage(
        rootDir,
        '@example/b',
        {
          version: '1.0.0',
        },
      );

      await writeText(path.join(dependencyOutDir, 'README.md'), '# New docs\n');
      await writeText(
        path.join(dependencyOutDir, 'docs/guide.md'),
        '# Guide\n',
      );
      await writeText(
        path.join(dependencyOutDir, 'examples/basic.js'),
        'export const example = true;\n',
      );
      registerPublishedPackage('@example/b', '1.0.0');

      await expect(
        runReleaseCheck({
          config: createConfig(
            rootDir,
            [
              {
                checks: ['boundary'],
                name: '@example/a',
                outDir,
              },
            ],
            {
              release: {
                contentHash: {
                  builtinIgnore: true,
                },
              },
            },
          ),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(true);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('uses builtin contentHash ignores when ignore returns undefined', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(
        rootDir,
        '@example/a',
        {
          dependencies: {
            '@example/b': 'workspace:*',
          },
        },
        {
          dependencies: {
            '@example/b': '^1.0.0',
          },
        },
      );
      const dependencyOutDir = await createWorkspacePackage(
        rootDir,
        '@example/b',
        {
          version: '1.0.0',
        },
      );

      await writeText(path.join(dependencyOutDir, 'README.md'), '# New docs\n');
      registerPublishedPackage('@example/b', '1.0.0');

      await expect(
        runReleaseCheck({
          config: createConfig(
            rootDir,
            [
              {
                checks: ['boundary'],
                name: '@example/a',
                outDir,
              },
            ],
            {
              release: {
                contentHash: {
                  builtinIgnore: true,
                  ignore: (): string[] | undefined => undefined,
                },
              },
            },
          ),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(true);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('does not use builtin contentHash ignores when ignore returns an empty array', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(
        rootDir,
        '@example/a',
        {
          dependencies: {
            '@example/b': 'workspace:*',
          },
        },
        {
          dependencies: {
            '@example/b': '^1.0.0',
          },
        },
      );
      const dependencyOutDir = await createWorkspacePackage(
        rootDir,
        '@example/b',
        {
          version: '1.0.0',
        },
      );

      await writeText(path.join(dependencyOutDir, 'README.md'), '# New docs\n');
      registerPublishedPackage('@example/b', '1.0.0');

      await expect(
        runReleaseCheck({
          config: createConfig(
            rootDir,
            [
              {
                checks: ['boundary'],
                name: '@example/a',
                outDir,
              },
            ],
            {
              release: {
                contentHash: {
                  builtinIgnore: true,
                  ignore: () => [],
                },
              },
            },
          ),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(false);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('fails when dependency package.json differs from npm latest', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(
        rootDir,
        '@example/a',
        {
          dependencies: {
            '@example/b': 'workspace:*',
          },
        },
        {
          dependencies: {
            '@example/b': '^1.0.0',
          },
        },
      );

      await createWorkspacePackage(
        rootDir,
        '@example/b',
        {
          version: '1.0.0',
        },
        {
          description: 'changed delivered manifest',
          version: '1.0.0',
        },
      );
      registerPublishedPackage('@example/b', '1.0.0');

      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              name: '@example/a',
              outDir,
            },
          ]),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(false);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('prints release-relevant contentHash diff file names when dependency output differs', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(
        rootDir,
        '@example/a',
        {
          dependencies: {
            '@example/b': 'workspace:*',
          },
        },
        {
          dependencies: {
            '@example/b': '^1.0.0',
          },
        },
      );
      const dependencyOutDir = await createWorkspacePackage(
        rootDir,
        '@example/b',
        {
          version: '1.0.0',
        },
      );

      await writeText(
        path.join(dependencyOutDir, 'dist/shared/dep-abc.js'),
        'export const dep = "local";\n',
      );
      await writeText(
        path.join(dependencyOutDir, 'index.js'),
        'export const value = "local";\n',
      );
      await writeText(
        path.join(dependencyOutDir, 'index.d.ts'),
        'export declare const value: "local";\n',
      );
      registerPublishedPackage('@example/b', '1.0.0', {
        files: {
          'dist/shared/dep-cba.js': 'export const dep = "remote";\n',
          'index.d.ts': 'export declare const value: "remote";\n',
          'index.js': 'export const value = "remote";\n',
        },
      });

      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              name: '@example/a',
              outDir,
            },
          ]),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(false);

      const output = stripAnsi(
        [...logSpy.mock.calls, ...errorSpy.mock.calls]
          .map((call) => call.map(String).join(' '))
          .join('\n'),
      );

      expect(output).toContain('[release-check] FAIL @example/a -> @example/b');
      expect(output).toContain('Baseline: npm latest -> @example/b@1.0.0');
      expect(output).toContain('Release-relevant diffs:');
      expect(output).toContain('local-only:');
      expect(output).toContain('dist/shared/dep-abc.js');
      expect(output).toContain('remote-only:');
      expect(output).toContain('dist/shared/dep-cba.js');
      expect(output).toContain('changed:');
      expect(output).toContain('index.d.ts');
      expect(output).toContain('index.js');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('passes when dependency package.json differences match a user contentHash ignore glob', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(
        rootDir,
        '@example/a',
        {
          dependencies: {
            '@example/b': 'workspace:*',
          },
        },
        {
          dependencies: {
            '@example/b': '^1.0.0',
          },
        },
      );

      await createWorkspacePackage(
        rootDir,
        '@example/b',
        {
          version: '1.0.0',
        },
        {
          description: 'ignored delivered manifest change',
          version: '1.0.0',
        },
      );
      registerPublishedPackage('@example/b', '1.0.0');

      await expect(
        runReleaseCheck({
          config: createConfig(
            rootDir,
            [
              {
                checks: ['boundary'],
                name: '@example/a',
                outDir,
              },
            ],
            {
              release: {
                contentHash: {
                  ignore: ['package.json'],
                },
              },
            },
          ),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(true);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('adds a workspace dependency to publish order when registry metadata returns 404', async () => {
    const { outDir, rootDir } = await createWorkspaceDependencyReleaseFixture();
    const errorSpy = vi
      .spyOn(ReleaseLogger, 'error')
      .mockImplementation(() => {});

    try {
      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              name: '@example/a',
              outDir,
            },
          ]),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(false);

      const errorText = errorSpy.mock.calls.join('\n');

      expect(errorText).toContain(
        '@example/b is not published to the npm registry',
      );
      expect(errorText).toContain(
        'Suggested publish order: @example/b -> @example/a',
      );
    } finally {
      errorSpy.mockRestore();
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('aborts registry metadata requests after 30 seconds', async () => {
    const { outDir, rootDir } = await createWorkspaceDependencyReleaseFixture();
    const errorSpy = vi
      .spyOn(ReleaseLogger, 'error')
      .mockImplementation(() => {});
    const defaultFetch = vi.mocked(fetch).getMockImplementation()!;
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });

    vi.useFakeTimers();
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((delay) => {
        const controller = new AbortController();

        setTimeout(
          () => controller.abort(new Error('registry request timed out')),
          delay,
        );
        return controller.signal;
      });
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === 'https://registry.npmjs.org/%40example%2Fb') {
        markRequestStarted();
        return waitForAbort(init?.signal);
      }

      return defaultFetch(input, init);
    });

    try {
      const resultPromise = runReleaseCheck({
        config: createConfig(rootDir, [
          {
            checks: ['boundary'],
            name: '@example/a',
            outDir,
          },
        ]),
        packageNames: ['@example/a'],
      });
      let settled = false;

      const settlementPromise = resultPromise.then(() => {
        settled = true;
      });
      await requestStarted;

      expect(timeoutSpy).toHaveBeenCalledWith(30_000);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(resultPromise).resolves.toBe(false);
      await settlementPromise;
      expect(errorSpy.mock.calls.join('\n')).toContain(
        'npm registry metadata request for @example/b from https://registry.npmjs.org/%40example%2Fb timed out after 30 seconds',
      );
    } finally {
      timeoutSpy.mockRestore();
      vi.useRealTimers();
      errorSpy.mockRestore();
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it.each([
    [401, 'Unauthorized'],
    [403, 'Forbidden'],
    [429, 'Too Many Requests'],
    [500, 'Internal Server Error'],
    [503, 'Service Unavailable'],
  ])(
    'reports registry HTTP %s without inferring publish order',
    async (status, statusText) => {
      const { outDir, rootDir } =
        await createWorkspaceDependencyReleaseFixture();
      const errorSpy = vi
        .spyOn(ReleaseLogger, 'error')
        .mockImplementation(() => {});
      packageCheckMocks.registryResponses.set('@example/b', {
        status,
        statusText,
      });

      try {
        await expect(
          runReleaseCheck({
            config: createConfig(rootDir, [
              {
                checks: ['boundary'],
                name: '@example/a',
                outDir,
              },
            ]),
            packageNames: ['@example/a'],
          }),
        ).resolves.toBe(false);

        const errorText = errorSpy.mock.calls.join('\n');

        expect(errorText).toContain(`${status} ${statusText}`);
        expect(errorText).not.toContain('Suggested publish order:');
      } finally {
        errorSpy.mockRestore();
        await rm(rootDir, {
          force: true,
          recursive: true,
        });
      }
    },
  );

  it.each([
    [
      'network failure',
      {
        fetchError: new Error('network unavailable'),
        status: 0,
        statusText: '',
      },
      'network unavailable',
    ],
    [
      'invalid JSON',
      {
        jsonError: new SyntaxError('invalid registry JSON'),
        status: 200,
        statusText: 'OK',
      },
      'invalid registry JSON',
    ],
    [
      'body read failure',
      {
        bodyError: new Error('registry body interrupted'),
        status: 200,
        statusText: 'OK',
      },
      'unable to read npm registry metadata response body',
    ],
    [
      'non-object metadata',
      {
        body: [],
        status: 200,
        statusText: 'OK',
      },
      'registry metadata response must be a JSON object',
    ],
  ])(
    'reports %s without inferring publish order',
    async (_label, response, expectedMessage) => {
      const { outDir, rootDir } =
        await createWorkspaceDependencyReleaseFixture();
      const errorSpy = vi
        .spyOn(ReleaseLogger, 'error')
        .mockImplementation(() => {});
      packageCheckMocks.registryResponses.set('@example/b', response);

      try {
        await expect(
          runReleaseCheck({
            config: createConfig(rootDir, [
              {
                checks: ['boundary'],
                name: '@example/a',
                outDir,
              },
            ]),
            packageNames: ['@example/a'],
          }),
        ).resolves.toBe(false);

        const errorText = errorSpy.mock.calls.join('\n');

        expect(errorText).toContain(expectedMessage);
        expect(errorText).not.toContain('Suggested publish order:');
      } finally {
        errorSpy.mockRestore();
        await rm(rootDir, {
          force: true,
          recursive: true,
        });
      }
    },
  );

  it('fails when workspace dependency registry metadata has no latest dist-tag', async () => {
    const rootDir = await createWorkspaceRoot();
    const errorSpy = vi
      .spyOn(ReleaseLogger, 'error')
      .mockImplementation(() => {});

    try {
      const outDir = await createWorkspacePackage(
        rootDir,
        '@example/a',
        {
          dependencies: {
            '@example/b': 'workspace:*',
          },
        },
        {
          dependencies: {
            '@example/b': '^1.0.0',
          },
        },
      );

      await createWorkspacePackage(rootDir, '@example/b', {
        version: '1.0.0',
      });
      registerPackageMetadata('@example/b', {
        versions: {},
      });

      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              name: '@example/a',
              outDir,
            },
          ]),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(false);

      expect(errorSpy.mock.calls.join('\n')).not.toContain(
        'Suggested publish order:',
      );
    } finally {
      errorSpy.mockRestore();
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('fails when the configured release contentHash dist-tag is missing', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(
        rootDir,
        '@example/a',
        {
          dependencies: {
            '@example/b': 'workspace:*',
          },
        },
        {
          dependencies: {
            '@example/b': '^1.0.0',
          },
        },
      );

      await createWorkspacePackage(rootDir, '@example/b', {
        version: '1.0.0',
      });
      registerPublishedPackage('@example/b', '1.0.0');

      await expect(
        runReleaseCheck({
          config: createConfig(
            rootDir,
            [
              {
                checks: ['boundary'],
                name: '@example/a',
                outDir,
              },
            ],
            {
              release: {
                contentHash: {
                  baselineTag: 'beta',
                },
              },
            },
          ),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(false);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('fails when workspace dependency latest metadata has no tarball URL', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(
        rootDir,
        '@example/a',
        {
          dependencies: {
            '@example/b': 'workspace:*',
          },
        },
        {
          dependencies: {
            '@example/b': '^1.0.0',
          },
        },
      );

      await createWorkspacePackage(rootDir, '@example/b', {
        version: '1.0.0',
      });
      registerPublishedPackage('@example/b', '1.0.0', {
        includeTarballUrl: false,
      });

      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              name: '@example/a',
              outDir,
            },
          ]),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(false);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('fails when workspace dependency latest tarball cannot be downloaded', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(
        rootDir,
        '@example/a',
        {
          dependencies: {
            '@example/b': 'workspace:*',
          },
        },
        {
          dependencies: {
            '@example/b': '^1.0.0',
          },
        },
      );

      await createWorkspacePackage(rootDir, '@example/b', {
        version: '1.0.0',
      });
      registerPublishedPackage('@example/b', '1.0.0', {
        registerTarball: false,
      });

      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              name: '@example/a',
              outDir,
            },
          ]),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(false);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('aborts a slow registry tarball body after 120 seconds', async () => {
    const { outDir, rootDir } = await createWorkspaceDependencyReleaseFixture();
    const errorSpy = vi
      .spyOn(ReleaseLogger, 'error')
      .mockImplementation(() => {});
    const defaultFetch = vi.mocked(fetch).getMockImplementation()!;
    let markBodyStarted!: () => void;
    const bodyStarted = new Promise<void>((resolve) => {
      markBodyStarted = resolve;
    });

    registerPublishedPackage('@example/b', '1.0.0');
    vi.useFakeTimers();
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((delay) => {
        const controller = new AbortController();

        setTimeout(
          () => controller.abort(new Error('registry request timed out')),
          delay,
        );
        return controller.signal;
      });
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith('.tgz')) {
        return {
          arrayBuffer: async () => {
            markBodyStarted();
            return waitForAbort(init?.signal);
          },
          ok: true,
          status: 200,
          statusText: 'OK',
        } as unknown as Response;
      }

      return defaultFetch(input, init);
    });

    try {
      const resultPromise = runReleaseCheck({
        config: createConfig(rootDir, [
          {
            checks: ['boundary'],
            name: '@example/a',
            outDir,
          },
        ]),
        packageNames: ['@example/a'],
      });
      let settled = false;

      const settlementPromise = resultPromise.then(() => {
        settled = true;
      });
      await bodyStarted;

      expect(timeoutSpy).toHaveBeenCalledWith(120_000);
      await vi.advanceTimersByTimeAsync(119_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(resultPromise).resolves.toBe(false);
      await settlementPromise;
      expect(errorSpy.mock.calls.join('\n')).toContain(
        'npm tarball request for https://registry.npmjs.org/%40example%2Fb/-/example-b-1.0.0.tgz timed out after 120 seconds',
      );
    } finally {
      timeoutSpy.mockRestore();
      vi.useRealTimers();
      errorSpy.mockRestore();
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('reports registry tarball body read failures separately', async () => {
    const { outDir, rootDir } = await createWorkspaceDependencyReleaseFixture();
    const errorSpy = vi
      .spyOn(ReleaseLogger, 'error')
      .mockImplementation(() => {});
    const defaultFetch = vi.mocked(fetch).getMockImplementation()!;

    registerPublishedPackage('@example/b', '1.0.0');
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith('.tgz')) {
        return {
          arrayBuffer: async () => {
            throw new Error('tarball body interrupted');
          },
          ok: true,
          status: 200,
          statusText: 'OK',
        } as unknown as Response;
      }

      return defaultFetch(input, init);
    });

    try {
      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              name: '@example/a',
              outDir,
            },
          ]),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(false);
      expect(errorSpy.mock.calls.join('\n')).toContain(
        'unable to read npm tarball response body for https://registry.npmjs.org/%40example%2Fb/-/example-b-1.0.0.tgz: tarball body interrupted',
      );
    } finally {
      errorSpy.mockRestore();
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it.each([
    {
      expectedMessage:
        '@example/b@1.0.0 registry metadata has no dist.integrity or dist.shasum',
      name: 'missing integrity metadata',
      registration: {
        includeIntegrity: false,
      },
    },
    {
      expectedMessage:
        '@example/b@1.0.0 registry metadata has invalid dist.integrity',
      name: 'invalid integrity metadata even when shasum is valid',
      registration: {
        integrity: 'not-valid-sri',
        shasum: createShasum('published tarball @example/b@1.0.0'),
      },
    },
    {
      expectedMessage:
        '@example/b@1.0.0 registry metadata has invalid dist.shasum',
      name: 'invalid shasum metadata',
      registration: {
        includeIntegrity: false,
        shasum: 'not-a-sha1-digest',
      },
    },
  ])('fails before unpacking when $name is received', async (testCase) => {
    const { outDir, rootDir } = await createWorkspaceDependencyReleaseFixture();
    const errorSpy = vi
      .spyOn(ReleaseLogger, 'error')
      .mockImplementation(() => {});

    registerPublishedPackage('@example/b', '1.0.0', testCase.registration);

    try {
      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              name: '@example/a',
              outDir,
            },
          ]),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(false);
      expect(errorSpy.mock.calls.join('\n')).toContain(
        testCase.expectedMessage,
      );
      expect(packageCheckMocks.unpackCalls).not.toContain(
        'published tarball @example/b@1.0.0',
      );
    } finally {
      errorSpy.mockRestore();
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('fails before unpacking when registry tarball integrity does not match', async () => {
    const { outDir, rootDir } = await createWorkspaceDependencyReleaseFixture();
    const errorSpy = vi
      .spyOn(ReleaseLogger, 'error')
      .mockImplementation(() => {});

    registerPublishedPackage('@example/b', '1.0.0', {
      integrity: createIntegrity('different tarball'),
    });

    try {
      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              name: '@example/a',
              outDir,
            },
          ]),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(false);
      expect(errorSpy.mock.calls.join('\n')).toContain(
        'npm tarball integrity mismatch for @example/b@1.0.0 from https://registry.npmjs.org/%40example%2Fb/-/example-b-1.0.0.tgz',
      );
      expect(packageCheckMocks.unpackCalls).not.toContain(
        'published tarball @example/b@1.0.0',
      );
    } finally {
      errorSpy.mockRestore();
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it.each([
    {
      name: 'valid integrity',
      registration: {
        integrity: createIntegrity(
          'published tarball @example/b@1.0.0',
          'sha512',
        ),
      },
    },
    {
      name: 'multi-algorithm integrity',
      registration: {
        integrity: [
          createIntegrity('published tarball @example/b@1.0.0', 'sha256'),
          createIntegrity('published tarball @example/b@1.0.0', 'sha512'),
        ].join(' '),
      },
    },
    {
      name: 'shasum fallback',
      registration: {
        includeIntegrity: false,
        shasum: createShasum('published tarball @example/b@1.0.0'),
      },
    },
  ])('accepts registry tarballs with $name', async (testCase) => {
    const { outDir, rootDir } = await createWorkspaceDependencyReleaseFixture();

    registerPublishedPackage('@example/b', '1.0.0', testCase.registration);

    try {
      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              name: '@example/a',
              outDir,
            },
          ]),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(true);
      expect(packageCheckMocks.unpackCalls).toContain(
        'published tarball @example/b@1.0.0',
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('does not run release dependency verification during package checks', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(
        rootDir,
        '@example/a',
        {
          dependencies: {
            '@example/b': 'workspace:*',
          },
        },
        {
          dependencies: {
            '@example/b': '^1.0.0',
          },
        },
      );

      await createWorkspacePackage(rootDir, '@example/b', {
        version: '1.0.0',
      });

      await expect(
        runPackageCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              name: '@example/a',
              outDir,
            },
          ]),
        }),
      ).resolves.toBe(true);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('fails when a workspace dependency local package output differs from npm latest', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(
        rootDir,
        '@example/a',
        {
          dependencies: {
            '@example/b': 'workspace:*',
          },
        },
        {
          dependencies: {
            '@example/b': '^1.0.0',
          },
        },
      );

      const dependencyOutDir = await createWorkspacePackage(
        rootDir,
        '@example/b',
        {
          version: '1.0.0',
        },
      );
      await writeText(
        path.join(dependencyOutDir, 'index.js'),
        'export const value = 2;\n',
      );
      registerPublishedPackage('@example/b', '1.0.0');

      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              name: '@example/a',
              outDir,
            },
          ]),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(false);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('fails when the packed dependency range does not cover the workspace package version', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(
        rootDir,
        '@example/a',
        {
          dependencies: {
            '@example/b': 'workspace:*',
          },
        },
        {
          dependencies: {
            '@example/b': '^1.0.0',
          },
        },
      );

      await createWorkspacePackage(rootDir, '@example/b', {
        version: '2.0.0',
      });
      registerPublishedPackage('@example/b', '2.0.0');

      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              name: '@example/a',
              outDir,
            },
          ]),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(false);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('passes when workspace dependencies are published and packed ranges cover them', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(
        rootDir,
        '@example/a',
        {
          dependencies: {
            '@example/b': 'workspace:*',
          },
        },
        {
          dependencies: {
            '@example/b': '^1.2.0',
          },
        },
      );

      await createWorkspacePackage(rootDir, '@example/b', {
        version: '1.2.0',
      });
      registerPublishedPackage('@example/b', '1.2.0');

      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              name: '@example/a',
              outDir,
            },
          ]),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(true);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('reports recursive workspace dependency publish order', async () => {
    const rootDir = await createWorkspaceRoot();
    const errorSpy = vi
      .spyOn(ReleaseLogger, 'error')
      .mockImplementation(() => {});

    try {
      const outDir = await createWorkspacePackage(
        rootDir,
        '@example/a',
        {
          dependencies: {
            '@example/b': 'workspace:*',
          },
        },
        {
          dependencies: {
            '@example/b': '^1.0.0',
          },
        },
      );

      const dependencyOutDirB = await createWorkspacePackage(
        rootDir,
        '@example/b',
        {
          dependencies: {
            '@example/c': 'workspace:*',
          },
          version: '1.0.0',
        },
      );
      const dependencyOutDirC = await createWorkspacePackage(
        rootDir,
        '@example/c',
        {
          version: '1.0.0',
        },
      );
      await writeText(
        path.join(dependencyOutDirB, 'index.js'),
        'export const value = 2;\n',
      );
      await writeText(
        path.join(dependencyOutDirC, 'index.js'),
        'export const value = 2;\n',
      );
      registerPublishedPackage('@example/b', '1.0.0');
      registerPublishedPackage('@example/c', '1.0.0');

      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              name: '@example/a',
              outDir,
            },
          ]),
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(false);

      expect(errorSpy.mock.calls.join('\n')).toContain(
        'Suggested publish order: @example/c -> @example/b -> @example/a',
      );
    } finally {
      errorSpy.mockRestore();
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('uses the activated package index for release checks from cwd', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(rootDir, '@example/a', {});
      const cwd = path.join(rootDir, 'packages/a/src/nested');

      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              name: '@example/a',
              outDir,
            },
          ]),
          cwd,
        }),
      ).resolves.toBe(true);

      expect(packageCheckMocks.packCalls).toEqual([outDir]);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('excludes overlap package cwd authority but keeps explicit release entries', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(rootDir, '@example/a', {});
      const packageRoot = path.join(rootDir, 'packages/a');
      const config = createConfig(rootDir, [
        {
          name: '@example/a',
          outDir,
        },
      ]);
      config.regions = {
        exclude: [
          {
            include: ['packages/a'],
            kind: 'workspace-package',
            reason: 'The nested workspace is checked separately.',
          },
        ],
      };
      await writeText(
        path.join(packageRoot, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );

      await expect(
        runReleaseCheck({
          config,
          cwd: path.join(packageRoot, 'src'),
        }),
      ).rejects.toThrow(/No activated workspace package/u);
      await expect(
        runReleaseCheck({
          config,
          packageNames: ['@example/a'],
        }),
      ).resolves.toBe(true);

      expect(packageCheckMocks.packCalls).toEqual([outDir]);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('fails release checks when cwd is not in a named activated package', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(rootDir, '@example/a', {});
      const cwd = path.join(rootDir, 'packages/nameless');

      await writeText(path.join(cwd, 'package.json'), JSON.stringify({}));

      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              name: '@example/a',
              outDir,
            },
          ]),
          cwd,
        }),
      ).rejects.toThrow(/No activated workspace package|has no package name/iu);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('fails release checks when the activated cwd package has no entry', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDir = await createWorkspacePackage(rootDir, '@example/a', {});
      const cwd = path.join(rootDir, 'packages/missing');

      await writeText(
        path.join(cwd, 'package.json'),
        JSON.stringify({
          name: '@example/missing',
        }),
      );

      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              name: '@example/a',
              outDir,
            },
          ]),
          cwd,
        }),
      ).rejects.toThrow(/does not match a configured package entry/u);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('runs explicit release check packages in order and deduplicates them', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      const outDirA = await createWorkspacePackage(rootDir, '@example/a', {});
      const outDirB = await createWorkspacePackage(rootDir, '@example/b', {});

      await expect(
        runReleaseCheck({
          config: createConfig(rootDir, [
            {
              name: '@example/a',
              outDir: outDirA,
            },
            {
              name: '@example/b',
              outDir: outDirB,
            },
          ]),
          packageNames: ['@example/a', '@example/b', '@example/a'],
        }),
      ).resolves.toBe(true);

      expect(packageCheckMocks.packCalls).toHaveLength(2);
      expect([...packageCheckMocks.packCalls].sort()).toEqual(
        [outDirA, outDirB].sort(),
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('selects every independently configured artifact entry with an explicit package name', async () => {
    const firstArtifact = await createOutputPackage({
      'index.js': "import '@example/dep';\n",
    });
    const secondArtifact = await createOutputPackage({
      'index.js': "import '@example/dep';\n",
    });
    const rootDir = await createWorkspaceRoot();

    try {
      await expect(
        runPackageCheck({
          config: createConfig(rootDir, [
            {
              checks: ['publint'],
              name: '@example/artifact',
              outDir: firstArtifact.outDir,
            },
            {
              checks: ['publint'],
              name: '@example/artifact',
              outDir: secondArtifact.outDir,
            },
          ]),
          packageNames: ['@example/artifact'],
        }),
      ).resolves.toBe(true);

      expect(packageCheckMocks.packCalls).toEqual(
        expect.arrayContaining([firstArtifact.outDir, secondArtifact.outDir]),
      );
      expect(packageCheckMocks.packCalls).toHaveLength(2);
    } finally {
      await firstArtifact.cleanup();
      await secondArtifact.cleanup();
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('selects multiple artifact entries for one activated cwd package', async () => {
    const firstArtifact = await createOutputPackage({
      'index.js': "import '@example/dep';\n",
    });
    const secondArtifact = await createOutputPackage({
      'index.js': "import '@example/dep';\n",
    });
    const rootDir = await createWorkspaceRoot();

    try {
      await createWorkspacePackage(rootDir, '@example/source', {});

      await expect(
        runPackageCheck({
          config: createConfig(rootDir, [
            {
              checks: ['publint'],
              name: '@example/source',
              outDir: firstArtifact.outDir,
            },
            {
              checks: ['publint'],
              name: '@example/source',
              outDir: secondArtifact.outDir,
            },
          ]),
          cwd: path.join(rootDir, 'packages/source/src'),
        }),
      ).resolves.toBe(true);

      expect(packageCheckMocks.packCalls).toEqual(
        expect.arrayContaining([firstArtifact.outDir, secondArtifact.outDir]),
      );
      expect(packageCheckMocks.packCalls).toHaveLength(2);
    } finally {
      await firstArtifact.cleanup();
      await secondArtifact.cleanup();
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('selects an external activated package and its external output from cwd', async () => {
    const parentDir = await mkdtemp(
      path.join(tmpdir(), 'limina-package-external-'),
    );
    const rootDir = path.join(parentDir, 'repo');
    const packageDir = path.join(parentDir, 'external', 'pkg');
    const outDir = path.join(packageDir, 'dist');

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages:\n  - ../external/*\n',
      );
      await writeText(
        path.join(packageDir, 'package.json'),
        JSON.stringify({ name: '@example/external', version: '1.0.0' }),
      );
      await writeText(
        path.join(packageDir, 'src/index.ts'),
        'export const source = true;\n',
      );
      await writeText(
        path.join(outDir, 'package.json'),
        JSON.stringify({
          dependencies: {},
          exports: { '.': './index.js' },
          license: 'MIT',
          name: '@example/external',
          types: './index.d.ts',
          version: '1.0.0',
        }),
      );
      await writeText(path.join(outDir, 'index.js'), 'export {};\n');

      await expect(
        runPackageCheck({
          config: createConfig(rootDir, [
            {
              checks: ['publint'],
              name: '@example/external',
              outDir: '../external/pkg/dist',
            },
          ]),
          cwd: path.join(packageDir, 'src'),
        }),
      ).resolves.toBe(true);

      expect(packageCheckMocks.packCalls).toEqual([outDir]);
    } finally {
      await rm(parentDir, { force: true, recursive: true });
    }
  });

  it('allows explicit artifact selection when the private root package has a different name', async () => {
    const rootDir = await createWorkspaceRoot();
    const outDir = path.join(rootDir, 'dist');

    try {
      await writeText(
        path.join(rootDir, 'package.json'),
        JSON.stringify({ name: '@example/root', private: true }),
      );
      await writeText(
        path.join(outDir, 'package.json'),
        JSON.stringify({
          dependencies: {},
          exports: { '.': './index.js' },
          license: 'MIT',
          name: '@example/artifact',
          types: './index.d.ts',
          version: '1.0.0',
        }),
      );
      await writeText(path.join(outDir, 'index.js'), 'export {};\n');

      await expect(
        runPackageCheck({
          config: createConfig(rootDir, [
            {
              checks: ['publint'],
              name: '@example/artifact',
              outDir: 'dist',
            },
          ]),
          packageNames: ['@example/artifact'],
        }),
      ).resolves.toBe(true);

      expect(packageCheckMocks.packCalls).toEqual([outDir]);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('filters configured entries by package name', async () => {
    const validPackage = await createOutputPackage({
      'index.js': "import '@example/dep';\n",
    });
    const invalidPackage = await createOutputPackage({
      'index.js': "import 'node:fs';\n",
    });
    const rootDir = await createWorkspaceRoot();

    try {
      await expect(
        runPackageCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              outDir: validPackage.outDir,
              name: '@example/valid',
            },
            {
              checks: ['boundary'],
              outDir: invalidPackage.outDir,
              name: '@example/invalid',
            },
          ]),
          packageNames: ['@example/valid'],
        }),
      ).resolves.toBe(true);
    } finally {
      await validPackage.cleanup();
      await invalidPackage.cleanup();
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('fails when an explicit package entry is not configured', async () => {
    const rootDir = await createWorkspaceRoot();

    try {
      await expect(
        runPackageCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              name: '@example/valid',
              outDir: 'packages/valid/dist',
            },
          ]),
          packageNames: ['@example/missing'],
        }),
      ).rejects.toThrow(/No package entry named "@example\/missing"/u);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('uses the activated cwd package when it matches a configured entry', async () => {
    const validPackage = await createOutputPackage({
      'index.js': "import '@example/dep';\n",
    });
    const invalidPackage = await createOutputPackage({
      'index.js': "import 'node:fs';\n",
    });
    const rootDir = await createWorkspaceRoot();
    const cwd = path.join(rootDir, 'packages/valid');

    try {
      await writeText(
        path.join(cwd, 'package.json'),
        JSON.stringify({
          name: '@example/valid',
        }),
      );

      await expect(
        runPackageCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              name: '@example/valid',
              outDir: validPackage.outDir,
            },
            {
              checks: ['boundary'],
              name: '@example/invalid',
              outDir: invalidPackage.outDir,
            },
          ]),
          cwd,
        }),
      ).resolves.toBe(true);
    } finally {
      await validPackage.cleanup();
      await invalidPackage.cleanup();
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('uses the activated package index for nested cwd paths', async () => {
    const validPackage = await createOutputPackage({
      'index.js': "import '@example/dep';\n",
    });
    const invalidPackage = await createOutputPackage({
      'index.js': "import 'node:fs';\n",
    });
    const rootDir = await createWorkspaceRoot();
    const packageDir = path.join(rootDir, 'packages/valid');
    const cwd = path.join(packageDir, 'src/nested');

    try {
      await writeText(
        path.join(packageDir, 'package.json'),
        JSON.stringify({
          name: '@example/valid',
        }),
      );

      await expect(
        runPackageCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              name: '@example/valid',
              outDir: validPackage.outDir,
            },
            {
              checks: ['boundary'],
              name: '@example/invalid',
              outDir: invalidPackage.outDir,
            },
          ]),
          cwd,
        }),
      ).resolves.toBe(true);
    } finally {
      await validPackage.cleanup();
      await invalidPackage.cleanup();
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('runs all entries when cwd package.json name is not configured', async () => {
    const validPackage = await createOutputPackage({
      'index.js': "import '@example/dep';\n",
    });
    const invalidPackage = await createOutputPackage({
      'index.js': "import 'node:fs';\n",
    });
    const rootDir = await createWorkspaceRoot();
    const cwd = path.join(rootDir, 'packages/other');

    try {
      await writeText(
        path.join(cwd, 'package.json'),
        JSON.stringify({
          name: '@example/other',
        }),
      );

      await expect(
        runPackageCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              name: '@example/valid',
              outDir: validPackage.outDir,
            },
            {
              checks: ['boundary'],
              name: '@example/invalid',
              outDir: invalidPackage.outDir,
            },
          ]),
          cwd,
        }),
      ).resolves.toBe(false);
    } finally {
      await validPackage.cleanup();
      await invalidPackage.cleanup();
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('runs all entries when cwd package.json is absent', async () => {
    const validPackage = await createOutputPackage({
      'index.js': "import '@example/dep';\n",
    });
    const invalidPackage = await createOutputPackage({
      'index.js': "import 'node:fs';\n",
    });
    const rootDir = await createWorkspaceRoot();
    const cwd = path.join(rootDir, 'packages/missing-manifest');

    try {
      await expect(
        runPackageCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              name: '@example/valid',
              outDir: validPackage.outDir,
            },
            {
              checks: ['boundary'],
              name: '@example/invalid',
              outDir: invalidPackage.outDir,
            },
          ]),
          cwd,
        }),
      ).resolves.toBe(false);
    } finally {
      await validPackage.cleanup();
      await invalidPackage.cleanup();
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('does not search beyond the workspace root for cwd package.json', async () => {
    const validPackage = await createOutputPackage({
      'index.js': "import '@example/dep';\n",
    });
    const invalidPackage = await createOutputPackage({
      'index.js': "import 'node:fs';\n",
    });
    const parentDir = await mkdtemp(
      path.join(tmpdir(), 'limina-package-parent-'),
    );
    const rootDir = path.join(parentDir, 'repo');
    const cwd = path.join(rootDir, 'packages/missing-manifest');

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages:\n  - packages/*\n',
      );
      await writeText(
        path.join(parentDir, 'package.json'),
        JSON.stringify({
          name: '@example/valid',
        }),
      );

      await expect(
        runPackageCheck({
          config: createConfig(rootDir, [
            {
              checks: ['boundary'],
              name: '@example/valid',
              outDir: validPackage.outDir,
            },
            {
              checks: ['boundary'],
              name: '@example/invalid',
              outDir: invalidPackage.outDir,
            },
          ]),
          cwd,
        }),
      ).resolves.toBe(false);
    } finally {
      await validPackage.cleanup();
      await invalidPackage.cleanup();
      await rm(parentDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('runs all package checks by default', async () => {
    const pkg = await createOutputPackage({
      'index.js': "import '@example/dep';\n",
    });

    try {
      await expect(
        runPackageCheck({
          config: createConfig(pkg.rootDir, [
            {
              outDir: pkg.outDir,
              name: '@example/pkg',
            },
          ]),
        }),
      ).resolves.toBe(true);

      expect(packageCheckMocks.packCalls).toEqual([pkg.outDir]);
      expect(packageCheckMocks.publintCalls).toHaveLength(1);
      expect(packageCheckMocks.attwRuns).toBe(1);
    } finally {
      await pkg.cleanup();
    }
  });

  it('runs only the selected tool', async () => {
    const pkg = await createOutputPackage({
      'index.js': "import 'node:fs';\n",
    });

    try {
      await expect(
        runPackageCheck({
          config: createConfig(pkg.rootDir, [
            {
              outDir: pkg.outDir,
              name: '@example/pkg',
            },
          ]),
          tool: 'publint',
        }),
      ).resolves.toBe(true);

      expect(packageCheckMocks.packCalls).toEqual([pkg.outDir]);
      expect(packageCheckMocks.publintCalls).toHaveLength(1);
      expect(packageCheckMocks.attwRuns).toBe(0);
    } finally {
      await pkg.cleanup();
    }
  });

  it('allows publint and attw to be disabled with boolean config', async () => {
    const pkg = await createOutputPackage({
      'index.js': "import '@example/dep';\n",
    });

    try {
      await expect(
        runPackageCheck({
          config: createConfig(pkg.rootDir, [
            {
              attw: false,
              name: '@example/pkg',
              outDir: pkg.outDir,
              publint: false,
            },
          ]),
        }),
      ).resolves.toBe(true);

      expect(packageCheckMocks.packCalls).toEqual([]);
      expect(packageCheckMocks.publintCalls).toHaveLength(0);
      expect(packageCheckMocks.attwRuns).toBe(0);
    } finally {
      await pkg.cleanup();
    }
  });

  it('allows publint and attw boolean true to re-enable checks omitted by checks', async () => {
    const pkg = await createOutputPackage({
      'index.js': "import '@example/dep';\n",
    });

    try {
      await expect(
        runPackageCheck({
          config: createConfig(pkg.rootDir, [
            {
              attw: true,
              checks: ['boundary'],
              name: '@example/pkg',
              outDir: pkg.outDir,
              publint: true,
            },
          ]),
        }),
      ).resolves.toBe(true);

      expect(packageCheckMocks.packCalls).toEqual([pkg.outDir]);
      expect(packageCheckMocks.publintCalls).toHaveLength(1);
      expect(packageCheckMocks.attwRuns).toBe(1);
    } finally {
      await pkg.cleanup();
    }
  });

  it('passes publint object config to publint', async () => {
    const pkg = await createOutputPackage({
      'index.js': 'export const value = 1;\n',
    });

    try {
      await expect(
        runPackageCheck({
          config: createConfig(pkg.rootDir, [
            {
              name: '@example/pkg',
              outDir: pkg.outDir,
              publint: {
                level: 'error',
                strict: false,
              },
            },
          ]),
          tool: 'publint',
        }),
      ).resolves.toBe(true);

      expect(packageCheckMocks.publintCalls[0]).toMatchObject({
        level: 'error',
        strict: false,
      });
    } finally {
      await pkg.cleanup();
    }
  });

  it('keeps arbitrary publint rule codes and messages external to the Limina code', async () => {
    const pkg = await createOutputPackage({
      'index.js': 'export const value = 1;\n',
    });
    const issues: LiminaCheckIssue[] = [];

    try {
      packageCheckMocks.publintRenderedMessages.set(
        'EXPORTS_MODULE_SHOULD_PRECEDE_TYPES',
        'first rendered wording',
      );
      packageCheckMocks.publintRenderedMessages.set(
        'FUTURE_PUBLINT_RULE',
        'changed future wording',
      );
      packageCheckMocks.publintMessages = [
        {
          code: 'EXPORTS_MODULE_SHOULD_PRECEDE_TYPES',
          type: 'error',
        },
        {
          code: 'FUTURE_PUBLINT_RULE',
          type: 'error',
        },
      ];

      await expect(
        runPackageCheck({
          config: createConfig(pkg.rootDir, [
            {
              name: '@example/pkg',
              outDir: pkg.outDir,
            },
          ]),
          deferSnapshot: true,
          issues,
          report: { defer: true },
          tool: 'publint',
        }),
      ).resolves.toBe(false);

      expect(issues).toHaveLength(2);
      expect(
        issues.map((issue) => ({
          code: issue.code,
          external: issue.external,
          packageManifestPath: issue.packageManifestPath,
          packageName: issue.packageName,
          task: issue.task,
        })),
      ).toEqual([
        {
          code: 'LIMINA_PACKAGE_PUBLINT',
          external: {
            code: 'EXPORTS_MODULE_SHOULD_PRECEDE_TYPES',
            message: 'first rendered wording',
            tool: 'publint',
          },
          packageManifestPath: 'output/package/package.json',
          packageName: '@example/pkg',
          task: 'package:check',
        },
        {
          code: 'LIMINA_PACKAGE_PUBLINT',
          external: {
            code: 'FUTURE_PUBLINT_RULE',
            message: 'changed future wording',
            tool: 'publint',
          },
          packageManifestPath: 'output/package/package.json',
          packageName: '@example/pkg',
          task: 'package:check',
        },
      ]);
    } finally {
      await pkg.cleanup();
    }
  });

  it('keeps current and future ATTW rule codes in external.code', async () => {
    const pkg = await createOutputPackage({
      'index.js': 'export const value = 1;\n',
    });
    const issues: LiminaCheckIssue[] = [];

    try {
      packageCheckMocks.attwProblems = [
        {
          implementationFileName: 'index.js',
          kind: 'FalseCJS',
          typesFileName: 'index.d.ts',
        },
        {
          kind: 'FutureAttwRule',
        },
      ];

      await expect(
        runPackageCheck({
          config: createConfig(pkg.rootDir, [
            {
              name: '@example/pkg',
              outDir: pkg.outDir,
            },
          ]),
          deferSnapshot: true,
          issues,
          report: { defer: true },
          tool: 'attw',
        }),
      ).resolves.toBe(false);

      expect(issues).toHaveLength(2);
      expect(
        issues.map((issue) => ({
          code: issue.code,
          externalCode: issue.external?.code,
          packageManifestPath: issue.packageManifestPath,
          packageName: issue.packageName,
          task: issue.task,
        })),
      ).toEqual([
        {
          code: 'LIMINA_PACKAGE_ATTW',
          externalCode: 'false-cjs',
          packageManifestPath: 'output/package/package.json',
          packageName: '@example/pkg',
          task: 'package:check',
        },
        {
          code: 'LIMINA_PACKAGE_ATTW',
          externalCode: 'FutureAttwRule',
          packageManifestPath: 'output/package/package.json',
          packageName: '@example/pkg',
          task: 'package:check',
        },
      ]);
    } finally {
      await pkg.cleanup();
    }
  });

  it('passes attw object config to checkPackage and ignores configured rules', async () => {
    const pkg = await createOutputPackage({
      'index.js': 'export const value = 1;\n',
    });

    try {
      packageCheckMocks.attwProblems = [
        {
          implementationFileName: 'index.js',
          kind: 'FalseCJS',
          typesFileName: 'index.d.ts',
        },
      ];

      await expect(
        runPackageCheck({
          config: createConfig(pkg.rootDir, [
            {
              attw: {
                entrypoints: ['.'],
                entrypointsLegacy: true,
                excludeEntrypoints: ['./internal'],
                ignoreRules: ['false-cjs'],
                includeEntrypoints: ['./feature'],
                profile: 'strict',
              },
              name: '@example/pkg',
              outDir: pkg.outDir,
            },
          ]),
          tool: 'attw',
        }),
      ).resolves.toBe(true);

      expect(packageCheckMocks.attwCheckOptions[0]).toEqual({
        entrypoints: ['.'],
        entrypointsLegacy: true,
        excludeEntrypoints: ['./internal'],
        includeEntrypoints: ['./feature'],
      });
    } finally {
      await pkg.cleanup();
    }
  });

  it('treats attw problems as warnings when attw.level is warn', async () => {
    const pkg = await createOutputPackage({
      'index.js': 'export const value = 1;\n',
    });

    try {
      packageCheckMocks.attwProblems = [
        {
          entrypoint: '.',
          kind: 'NoResolution',
          resolutionKind: 'node10',
        },
      ];

      await expect(
        runPackageCheck({
          config: createConfig(pkg.rootDir, [
            {
              attw: {
                level: 'warn',
                profile: 'strict',
              },
              name: '@example/pkg',
              outDir: pkg.outDir,
            },
          ]),
          tool: 'attw',
        }),
      ).resolves.toBe(true);
    } finally {
      await pkg.cleanup();
    }
  });

  it('prints the filtered checks in the package check plan', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const pkg = await createOutputPackage({
      'index.js': "import 'node:fs';\n",
    });

    try {
      await expect(
        runPackageCheck({
          config: createConfig(pkg.rootDir, [
            {
              name: '@example/pkg',
              outDir: pkg.outDir,
            },
          ]),
          tool: 'publint',
        }),
      ).resolves.toBe(true);

      const output = logSpy.mock.calls
        .map((call) => call.map(String).join(' '))
        .join('\n');

      expect(output).toContain('Package check plan:');
      expect(output).toContain('outDir: output/package');
      expect(output).toContain('checks: publint');
    } finally {
      logSpy.mockRestore();
      await pkg.cleanup();
    }
  });

  it('applies the default and overridden ATTW profile', async () => {
    const pkg = await createOutputPackage({
      'index.js': 'export const value = 1;\n',
    });
    const node16CjsProblem = {
      entrypoint: '.',
      kind: 'NoResolution',
      resolutionKind: 'node16-cjs',
    };

    try {
      packageCheckMocks.attwProblems = [node16CjsProblem];

      await expect(
        runPackageCheck({
          config: createConfig(pkg.rootDir, [
            {
              outDir: pkg.outDir,
              name: '@example/pkg',
            },
          ]),
          tool: 'attw',
        }),
      ).resolves.toBe(true);

      await expect(
        runPackageCheck({
          attwProfile: 'strict',
          config: createConfig(pkg.rootDir, [
            {
              outDir: pkg.outDir,
              name: '@example/pkg',
            },
          ]),
          tool: 'attw',
        }),
      ).resolves.toBe(false);
    } finally {
      await pkg.cleanup();
    }
  });

  it.each([
    {
      ignored: [] as string[],
      profile: 'strict' as const,
    },
    {
      ignored: ['node10'] as string[],
      profile: 'node16' as const,
    },
    {
      ignored: ['node10', 'node16-cjs'] as string[],
      profile: 'esm-only' as const,
    },
  ])(
    'filters the complete ATTW resolution matrix for $profile',
    async ({ ignored, profile }) => {
      const pkg = await createOutputPackage({
        'index.js': 'export const value = 1;\n',
      });
      const resolutionKinds = [
        'node10',
        'node16-cjs',
        'node16-esm',
        'bundler',
        'future-resolution',
      ];
      try {
        for (const resolutionKind of resolutionKinds) {
          packageCheckMocks.attwProblems = [
            {
              entrypoint: '.',
              kind: 'NoResolution',
              resolutionKind,
            },
          ];

          await expect(
            runPackageCheck({
              config: createConfig(pkg.rootDir, [
                {
                  attw: { profile },
                  name: '@example/pkg',
                  outDir: pkg.outDir,
                },
              ]),
              tool: 'attw',
            }),
          ).resolves.toBe(ignored.includes(resolutionKind));
        }
      } finally {
        await pkg.cleanup();
      }
    },
  );

  it('skips a missing publint peer only when publint is enabled', async () => {
    const pkg = await createOutputPackage({
      'index.js': "import '@example/dep';\n",
    });
    let stats: LiminaCheckRunTaskStats | undefined;

    try {
      vi.resetModules();
      vi.doMock('publint', () => {
        throw new Error('Cannot find package "publint"');
      });

      const { runPackageCheck: runPackageCheckWithMissingPublint } =
        await import('../commands/package');

      await expect(
        runPackageCheckWithMissingPublint({
          config: createConfig(pkg.rootDir, [
            {
              checks: ['boundary'],
              name: '@example/pkg',
              outDir: pkg.outDir,
            },
          ]),
        }),
      ).resolves.toBe(true);

      await expect(
        runPackageCheckWithMissingPublint({
          config: createConfig(pkg.rootDir, [
            {
              name: '@example/pkg',
              outDir: pkg.outDir,
            },
          ]),
          onStats: (nextStats) => {
            stats = nextStats;
          },
          tool: 'publint',
        }),
      ).resolves.toBe(true);

      expect(stats?.items?.[0]).toMatchObject({
        checksPassed: 0,
        checksTotal: 0,
        issues: 0,
        status: 'skipped',
      });
    } finally {
      vi.doUnmock('publint');
      vi.resetModules();
      await pkg.cleanup();
    }
  });

  it('skips a missing attw peer only when attw is enabled', async () => {
    const pkg = await createOutputPackage({
      'index.js': "import '@example/dep';\n",
    });
    let stats: LiminaCheckRunTaskStats | undefined;

    try {
      vi.resetModules();
      vi.doMock('@arethetypeswrong/core', () => {
        throw new Error('Cannot find package "@arethetypeswrong/core"');
      });

      const { runPackageCheck: runPackageCheckWithMissingAttw } = await import(
        '../commands/package'
      );

      await expect(
        runPackageCheckWithMissingAttw({
          config: createConfig(pkg.rootDir, [
            {
              checks: ['boundary'],
              name: '@example/pkg',
              outDir: pkg.outDir,
            },
          ]),
        }),
      ).resolves.toBe(true);

      await expect(
        runPackageCheckWithMissingAttw({
          config: createConfig(pkg.rootDir, [
            {
              name: '@example/pkg',
              outDir: pkg.outDir,
            },
          ]),
          onStats: (nextStats) => {
            stats = nextStats;
          },
          tool: 'attw',
        }),
      ).resolves.toBe(true);

      expect(stats?.items?.[0]).toMatchObject({
        checksPassed: 0,
        checksTotal: 0,
        issues: 0,
        status: 'skipped',
      });
    } finally {
      vi.doUnmock('@arethetypeswrong/core');
      vi.resetModules();
      await pkg.cleanup();
    }
  });
});
