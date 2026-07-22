import { unpack } from '@publint/pack';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { toPortablePath } from '../../src/__tests__/helpers/path';
import {
  DEFAULT_ISSUE_CODE_BY_TASK,
  LIMINA_CHECK_ISSUE_CODES,
} from '../../src/check-reporting/codes';
import {
  getStandaloneIssueInvocationPath,
  STANDALONE_ISSUE_INVOCATION_VERSION,
} from '../../src/check-reporting/invocation-snapshot';
import {
  CHECK_ISSUE_SNAPSHOT_VERSION,
  getCheckIssueSnapshotPath,
  type LiminaCheckIssue,
} from '../../src/check-reporting/snapshot';
import { createDetectorInvocationEnvironment } from '../helpers/detector-environment';
import {
  discoverDetectorFixtures,
  validateDetectorFixtureDefinition,
} from '../helpers/detector-fixture-discovery';
import { assertExecutableDetectorFixtureKind } from '../helpers/detector-fixture-runner';
import type {
  DetectorFixtureDefinition,
  DetectorFixtureExpectation,
  ExpectedIssue,
} from '../helpers/detector-fixture-types';
import {
  assertNoPreexistingCheckSnapshot,
  assertNoPreexistingDetectorSnapshots,
  readDetectorCheckSnapshot,
  readDetectorStructuredSnapshot,
} from '../helpers/detector-snapshot';
import { createDeterministicPackageTarball } from '../helpers/deterministic-tarball';
import { validatePortableRelativePath } from '../helpers/fixture-paths';
import {
  applyFixtureMutations,
  applyFixtureSetup,
  assertTreeSnapshotUnchanged,
  captureTreeSnapshot,
  cleanupDetectorSandbox,
  copyFixtureRepository,
  createDetectorSandbox,
  DEFAULT_SANDBOX_IGNORED_PATH_PREFIXES,
  finishFixtureCleanup,
  pathExists,
  SANDBOX_CLEANUP_MAX_RETRIES,
  SANDBOX_CLEANUP_RETRY_DELAY_MS,
} from '../helpers/fixture-sandbox';
import { assertDetectorIssues } from '../helpers/issue-assertions';
import {
  assertLocalRegistryRequests,
  startLocalRegistryFixture,
} from '../helpers/local-registry';
import { createLiminaSpawnSpec, liminaBinPath } from '../helpers/run-limina';
import { createFixtureToolBridges } from '../helpers/tool-bridge';

const temporaryRoots: string[] = [];

async function createTemporaryRoot(prefix: string): Promise<string> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), `limina-detector-${prefix}-`)),
  );
  temporaryRoots.push(rootDir);
  return rootDir;
}

async function writeText(filePath: string, content = ''): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

function validFailingDefinition(
  id = 'proof/example-case',
): DetectorFixtureDefinition {
  return {
    command: ['check', 'detector'],
    expected: {
      additionalCodes: [],
      exitCode: 1,
      issues: [
        {
          code: LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile,
          filePath: 'packages/pkg/uncovered.ts',
          task: 'proof:check',
        },
      ],
      primaryCode: LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile,
    },
    id,
    kind: 'filesystem',
    tools: ['typescript'],
  };
}

function expectedFailure(
  issues: readonly ExpectedIssue[],
  overrides: Partial<DetectorFixtureExpectation> = {},
): DetectorFixtureExpectation {
  return {
    additionalCodes: [],
    exitCode: 1,
    issues,
    primaryCode: LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile,
    ...overrides,
  };
}

function actualIssue(
  overrides: Partial<LiminaCheckIssue> = {},
): LiminaCheckIssue {
  return {
    code: LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile,
    filePath: 'packages/pkg/uncovered.ts',
    id: 'unstable-id',
    packageName: '@fixture/pkg',
    reason: 'presentation reason',
    task: 'proof:check',
    title: 'presentation title',
    ...overrides,
  };
}

function validSnapshot(command = 'limina check detector') {
  const createdAt = new Date().toISOString();
  return {
    command,
    createdAt,
    issues: [],
    run: {
      command,
      completedAt: createdAt,
      createdAt,
      durationMs: 0,
      pipeline: 'detector',
      result: 'passed' as const,
      startedAt: createdAt,
      tasks: [
        {
          completedAt: createdAt,
          durationMs: 0,
          generation: 0,
          id: 'task:proof',
          issueTask: 'proof:check' as const,
          kind: 'task' as const,
          label: 'proof:check',
          startedAt: createdAt,
          state: 'passed' as const,
        },
      ],
    },
    status: 'completed' as const,
    version: CHECK_ISSUE_SNAPSHOT_VERSION,
  };
}

async function writeSnapshot(
  rootDir: string,
  snapshot: unknown,
): Promise<string> {
  const snapshotPath = getCheckIssueSnapshotPath(rootDir);
  await writeText(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  return snapshotPath;
}

async function writeStandaloneInvocationSnapshot(
  rootDir: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const invocationId = '123e4567-e89b-42d3-a456-426614174000';
  const snapshotPath = getStandaloneIssueInvocationPath(rootDir, invocationId);
  const completedAt = new Date().toISOString();
  await writeText(
    snapshotPath,
    `${JSON.stringify(
      {
        command: 'limina checker build',
        completedAt,
        invocationId,
        issues: [
          actualIssue({
            code: LIMINA_CHECK_ISSUE_CODES.checkerTargetSelectionFailed,
            filePath: 'packages/app/tsconfig.json',
            task: 'checker:build',
          }),
        ],
        kind: 'standalone-invocation',
        result: 'failed',
        version: STANDALONE_ISSUE_INVOCATION_VERSION,
        ...overrides,
      },
      null,
      2,
    )}\n`,
  );
  return snapshotPath;
}

async function createDiscoveryFixture(
  detectorRoot: string,
  id: string,
): Promise<string> {
  const fixtureRoot = path.join(detectorRoot, ...id.split('/'));
  await mkdir(path.join(fixtureRoot, 'repo'), { recursive: true });
  const casePath = path.join(fixtureRoot, 'case.mts');
  await writeText(casePath, 'export default {};\n');
  return casePath;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((rootDir) =>
      rm(rootDir, {
        force: true,
        maxRetries: 5,
        recursive: true,
        retryDelay: 50,
      }),
    ),
  );
});

describe('detector fixture declaration and discovery', () => {
  it('executes filesystem, external-tool, and fault-injection fixtures', () => {
    const definition = validFailingDefinition();

    expect(() =>
      assertExecutableDetectorFixtureKind({
        definition,
        id: definition.id,
      }),
    ).not.toThrow();
    expect(() =>
      assertExecutableDetectorFixtureKind({
        definition: { ...definition, kind: 'external-tool' },
        id: definition.id,
      }),
    ).not.toThrow();
    expect(() =>
      assertExecutableDetectorFixtureKind({
        definition: { ...definition, kind: 'fault-injection' },
        id: definition.id,
      }),
    ).not.toThrow();
  });

  it('applies strict expectation defaults to a valid declaration', () => {
    const definition = validateDetectorFixtureDefinition(
      validFailingDefinition(),
      {
        casePath: '/fixtures/proof/example-case/case.mts',
        expectedId: 'proof/example-case',
      },
    );

    expect(definition.expected.additionalCodes).toEqual([]);
    expect(definition.expected.allowUnexpectedIssues).toBe(false);
  });

  it.each([
    '../proof/example',
    '/proof/example',
    'proof\\example',
    'proof//example',
    'proof/./example',
    'Proof/example',
  ])('rejects invalid fixture ID %s', (id) => {
    expect(() =>
      validateDetectorFixtureDefinition(validFailingDefinition(id), {
        casePath: '/fixtures/case.mts',
      }),
    ).toThrow(/id|portable|relative|segments/iu);
  });

  it('reports the case path, declared ID, and expected directory ID', () => {
    expect(() =>
      validateDetectorFixtureDefinition(validFailingDefinition('proof/wrong'), {
        casePath: '/fixtures/proof/right/case.mts',
        expectedId: 'proof/right',
      }),
    ).toThrow(
      'declaration in /fixtures/proof/right/case.mts has an ID/directory mismatch: declared "proof/wrong", expected "proof/right"',
    );
  });

  it('rejects empty commands and invalid exit codes', () => {
    expect(() =>
      validateDetectorFixtureDefinition(
        { ...validFailingDefinition(), command: [] },
        { casePath: '/fixtures/case.mts' },
      ),
    ).toThrow('command must contain at least one');
    expect(() =>
      validateDetectorFixtureDefinition(
        {
          ...validFailingDefinition(),
          expected: { ...validFailingDefinition().expected, exitCode: 1.5 },
        },
        { casePath: '/fixtures/case.mts' },
      ),
    ).toThrow('exitCode must be an integer');
  });

  it('rejects unknown, non-active, fallback-primary, and missing-primary codes', () => {
    const base = validFailingDefinition();
    expect(() =>
      validateDetectorFixtureDefinition(
        {
          ...base,
          expected: {
            ...base.expected,
            issues: [
              {
                code: 'LIMINA_NOT_REAL',
                task: 'proof:check',
              },
            ],
            primaryCode: 'LIMINA_NOT_REAL',
          },
        },
        { casePath: '/fixtures/case.mts' },
      ),
    ).toThrow('not a canonical Limina issue code');
    for (const [code, task] of [
      [LIMINA_CHECK_ISSUE_CODES.releaseConsistency, 'release:check'],
      [LIMINA_CHECK_ISSUE_CODES.pipelineCommandFailed, 'command'],
    ] as const) {
      expect(() =>
        validateDetectorFixtureDefinition(
          {
            ...base,
            expected: {
              ...base.expected,
              issues: [{ code, task }],
              primaryCode: code,
            },
          },
          { casePath: '/fixtures/case.mts' },
        ),
      ).toThrow('not an active Limina issue code');
    }
    expect(() =>
      validateDetectorFixtureDefinition(
        {
          ...base,
          expected: {
            ...base.expected,
            issues: [
              {
                code: DEFAULT_ISSUE_CODE_BY_TASK['proof:check'],
                task: 'proof:check',
              },
            ],
            primaryCode: DEFAULT_ISSUE_CODE_BY_TASK['proof:check'],
          },
        },
        { casePath: '/fixtures/case.mts' },
      ),
    ).toThrow('not a task fallback code');
    expect(() =>
      validateDetectorFixtureDefinition(
        {
          ...base,
          expected: { ...base.expected, issues: [] },
        },
        { casePath: '/fixtures/case.mts' },
      ),
    ).toThrow('must be represented');
  });

  it('rejects a primary code on a passing fixture and duplicate expectations', () => {
    const base = validFailingDefinition();
    expect(() =>
      validateDetectorFixtureDefinition(
        {
          ...base,
          expected: { ...base.expected, exitCode: 0 },
        },
        { casePath: '/fixtures/case.mts' },
      ),
    ).toThrow('not allowed for a passing fixture');
    expect(() =>
      validateDetectorFixtureDefinition(
        {
          ...base,
          expected: {
            ...base.expected,
            issues: [base.expected.issues[0]!, base.expected.issues[0]!],
          },
        },
        { casePath: '/fixtures/case.mts' },
      ),
    ).toThrow('indistinguishable duplicate');
  });

  it('rejects safety environment overrides and over-broad generated paths', () => {
    expect(() =>
      validateDetectorFixtureDefinition(
        { ...validFailingDefinition(), environment: { PATH: '/unsafe' } },
        { casePath: '/fixtures/case.mts' },
      ),
    ).toThrow('cannot override harness variable PATH');
    expect(() =>
      validateDetectorFixtureDefinition(
        { ...validFailingDefinition(), allowedGeneratedPaths: ['**/*'] },
        { casePath: '/fixtures/case.mts' },
      ),
    ).toThrow('over-broad pattern');
  });

  it('accepts only controlled external-tool registry declarations', () => {
    const definition = validateDetectorFixtureDefinition(
      {
        ...validFailingDefinition('release/registry-json'),
        kind: 'external-tool',
        registry: {
          expectedRequests: [
            {
              headers: { Accept: 'application/json' },
              pathname: '/%40fixture%2Fdependency',
            },
          ],
          metadata: {
            body: { kind: 'json', value: { versions: {} } },
          },
          packageName: '@fixture/dependency',
          requestTimeoutMs: 100,
        },
      },
      { casePath: '/fixtures/release/registry-json/case.mts' },
    );

    expect(definition.registry).toMatchObject({
      expectedRequests: [
        {
          headers: { accept: 'application/json' },
          pathname: '/%40fixture%2Fdependency',
        },
      ],
      packageName: '@fixture/dependency',
      requestTimeoutMs: 100,
    });

    expect(() =>
      validateDetectorFixtureDefinition(
        {
          ...validFailingDefinition('release/registry-invalid'),
          registry: {
            expectedRequests: [],
            metadata: {
              body: { kind: 'json', value: { callback: () => {} } },
            },
            packageName: '@fixture/dependency',
          },
        },
        { casePath: '/fixtures/release/registry-invalid/case.mts' },
      ),
    ).toThrow(/JSON-safe values|external-tool/u);
    expect(() =>
      validateDetectorFixtureDefinition(
        {
          ...validFailingDefinition('release/registry-path'),
          kind: 'external-tool',
          registry: {
            expectedRequests: [],
            metadata: { body: { kind: 'json', value: {} } },
            packageName: '@fixture/dependency',
            tarballs: {
              'https://registry.npmjs.org/pkg.tgz': {
                body: { kind: 'text', value: 'forbidden' },
              },
            },
          },
        },
        { casePath: '/fixtures/release/registry-path/case.mts' },
      ),
    ).toThrow(/absolute URL pathname/u);
  });

  it('discovers fixtures in portable sorted order', async () => {
    const rootDir = await createTemporaryRoot('discovery-order');
    const detectorRoot = path.join(rootDir, 'detectors');
    const zCase = await createDiscoveryFixture(detectorRoot, 'proof/z-case');
    const aCase = await createDiscoveryFixture(detectorRoot, 'graph/a-case');
    const fixtures = await discoverDetectorFixtures({
      caseModules: new Map([
        [zCase, { default: validFailingDefinition('proof/z-case') }],
        [aCase, { default: validFailingDefinition('graph/a-case') }],
      ]),
      detectorRoot,
    });

    expect(fixtures.map((fixture) => fixture.id)).toEqual([
      'graph/a-case',
      'proof/z-case',
    ]);
  });

  it('rejects duplicate declared IDs before directory mismatch', async () => {
    const rootDir = await createTemporaryRoot('discovery-duplicate');
    const detectorRoot = path.join(rootDir, 'detectors');
    const firstCase = await createDiscoveryFixture(detectorRoot, 'proof/one');
    const secondCase = await createDiscoveryFixture(detectorRoot, 'proof/two');

    await expect(
      discoverDetectorFixtures({
        caseModules: new Map([
          [firstCase, { default: validFailingDefinition('proof/shared') }],
          [secondCase, { default: validFailingDefinition('proof/shared') }],
        ]),
        detectorRoot,
      }),
    ).rejects.toThrow('Duplicate detector fixture ID: proof/shared');
  });

  it('rejects missing case.mts, missing repo, and unloaded declarations', async () => {
    const missingCaseRoot = await createTemporaryRoot('missing-case');
    const missingCaseDetectors = path.join(missingCaseRoot, 'detectors');
    await mkdir(path.join(missingCaseDetectors, 'proof/example/repo'), {
      recursive: true,
    });
    await expect(
      discoverDetectorFixtures({
        caseModules: new Map(),
        detectorRoot: missingCaseDetectors,
      }),
    ).rejects.toThrow('exactly one case.mts');

    const missingRepoRoot = await createTemporaryRoot('missing-repo');
    const missingRepoDetectors = path.join(missingRepoRoot, 'detectors');
    const missingRepoCase = path.join(
      missingRepoDetectors,
      'proof/example/case.mts',
    );
    await writeText(missingRepoCase, 'export default {};\n');
    await expect(
      discoverDetectorFixtures({
        caseModules: new Map([
          [missingRepoCase, { default: validFailingDefinition() }],
        ]),
        detectorRoot: missingRepoDetectors,
      }),
    ).rejects.toThrow('real repo directory');

    const unloadedRoot = await createTemporaryRoot('unloaded-case');
    const unloadedDetectors = path.join(unloadedRoot, 'detectors');
    const unloadedCase = await createDiscoveryFixture(
      unloadedDetectors,
      'proof/example-case',
    );
    await expect(
      discoverDetectorFixtures({
        caseModules: new Map(),
        detectorRoot: unloadedDetectors,
      }),
    ).rejects.toThrow(`not loaded by the test runner: ${unloadedCase}`);
  });
});

describe('detector fixture copy policy', () => {
  it('keeps permanent exclusions and makes dist/build-info opt-in', async () => {
    const rootDir = await createTemporaryRoot('copy-policy');
    const sourceRoot = path.join(rootDir, 'source');
    await Promise.all([
      writeText(path.join(sourceRoot, '.limina/secret.json'), 'secret'),
      writeText(path.join(sourceRoot, 'node_modules/pkg/index.js'), 'module'),
      writeText(path.join(sourceRoot, 'coverage/report.json'), 'coverage'),
      writeText(path.join(sourceRoot, 'dist/index.js'), 'dist'),
      writeText(path.join(sourceRoot, 'cache.tsbuildinfo'), 'build-info'),
      writeText(path.join(sourceRoot, 'src/index.ts'), 'source'),
    ]);
    const defaultDestination = path.join(rootDir, 'default-copy');
    await copyFixtureRepository({
      destinationRoot: defaultDestination,
      sourceRoot,
    });

    expect(await readdir(defaultDestination)).toEqual(['src']);

    const outputDestination = path.join(rootDir, 'output-copy');
    await copyFixtureRepository({
      destinationRoot: outputDestination,
      policy: {
        includeBuildInfoFiles: true,
        includeOutputDirectories: true,
      },
      sourceRoot,
    });
    expect(
      await pathExists(path.join(outputDestination, 'dist/index.js')),
    ).toBe(true);
    expect(
      await pathExists(path.join(outputDestination, 'cache.tsbuildinfo')),
    ).toBe(true);
    for (const permanentName of ['.limina', 'node_modules', 'coverage']) {
      expect(
        await pathExists(path.join(outputDestination, permanentName)),
      ).toBe(false);
    }
  });

  it('applies exact custom entry-name exclusions', async () => {
    const rootDir = await createTemporaryRoot('copy-custom');
    const sourceRoot = path.join(rootDir, 'source');
    await writeText(path.join(sourceRoot, 'keep/file.ts'), 'keep');
    await writeText(path.join(sourceRoot, 'omit/file.ts'), 'omit');
    const destinationRoot = path.join(rootDir, 'destination');
    await copyFixtureRepository({
      destinationRoot,
      policy: { excludedNames: ['omit'] },
      sourceRoot,
    });

    expect(await pathExists(path.join(destinationRoot, 'keep/file.ts'))).toBe(
      true,
    );
    expect(await pathExists(path.join(destinationRoot, 'omit'))).toBe(false);
  });

  it('rejects fixture source links with source and destination diagnostics', async () => {
    const rootDir = await createTemporaryRoot('copy-link');
    const sourceRoot = path.join(rootDir, 'source');
    const externalRoot = path.join(rootDir, 'external');
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(externalRoot, { recursive: true });
    const linkedPath = path.join(sourceRoot, 'linked');
    await symlink(
      externalRoot,
      linkedPath,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const destinationRoot = path.join(rootDir, 'destination');
    const error = await copyFixtureRepository({
      destinationRoot,
      sourceRoot,
    }).catch((error_: unknown) => error_);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(linkedPath);
    expect(toPortablePath((error as Error).message)).toContain(
      toPortablePath(path.join(destinationRoot, 'linked')),
    );
    expect((error as Error).message).toContain(
      'fixture source links are not supported',
    );
  });
});

describe('controlled setup and mutation operations', () => {
  it.each(['../outside', '/absolute', 'repo\\windows', 'repo//empty'])(
    'rejects unsafe portable path %s',
    (candidate) => {
      expect(() =>
        validatePortableRelativePath(candidate, { label: 'test path' }),
      ).toThrow();
    },
  );

  it('writes UTF-8 files in declaration order and refuses implicit overwrite', async () => {
    const sandboxRoot = await createTemporaryRoot('setup-write');
    await mkdir(path.join(sandboxRoot, 'repo'), { recursive: true });
    await applyFixtureSetup({
      fixtureId: 'proof/setup',
      operations: [
        {
          content: 'first',
          kind: 'write-file',
          path: 'repo/generated/value.txt',
        },
        {
          kind: 'remove-path',
          path: 'repo/generated/value.txt',
        },
        {
          content: 'second',
          kind: 'write-file',
          path: 'repo/generated/value.txt',
        },
      ],
      sandboxRoot,
    });
    expect(
      await readFile(
        path.join(sandboxRoot, 'repo/generated/value.txt'),
        'utf8',
      ),
    ).toBe('second');
    await expect(
      applyFixtureSetup({
        fixtureId: 'proof/setup',
        operations: [
          {
            content: 'overwrite',
            kind: 'write-file',
            path: 'repo/generated/value.txt',
          },
        ],
        sandboxRoot,
      }),
    ).rejects.toThrow('target already exists');
  });

  it('does not follow an existing link while writing', async () => {
    const sandboxRoot = await createTemporaryRoot('setup-link-escape');
    const externalRoot = await createTemporaryRoot('setup-link-external');
    await mkdir(path.join(sandboxRoot, 'repo'), { recursive: true });
    await symlink(
      externalRoot,
      path.join(sandboxRoot, 'repo/linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(
      applyFixtureSetup({
        fixtureId: 'proof/setup-link',
        operations: [
          {
            content: 'unsafe',
            kind: 'write-file',
            path: 'repo/linked/outside.txt',
          },
        ],
        sandboxRoot,
      }),
    ).rejects.toThrow('traverses a link');
    expect(await pathExists(path.join(externalRoot, 'outside.txt'))).toBe(
      false,
    );
  });

  it('creates a canonical directory link using the platform strategy', async () => {
    const sandboxRoot = await createTemporaryRoot('setup-directory-link');
    await mkdir(path.join(sandboxRoot, 'repo/target'), { recursive: true });
    await applyFixtureSetup({
      fixtureId: 'proof/setup-link',
      operations: [
        {
          kind: 'directory-link',
          path: 'repo/linked',
          target: 'repo/target',
        },
      ],
      sandboxRoot,
    });
    const linkPath = path.join(sandboxRoot, 'repo/linked');
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(toPortablePath(await realpath(linkPath))).toBe(
      toPortablePath(await realpath(path.join(sandboxRoot, 'repo/target'))),
    );
  });

  it('removes a directory link without deleting its target', async () => {
    const sandboxRoot = await createTemporaryRoot('setup-remove-link');
    await mkdir(path.join(sandboxRoot, 'repo/target'), { recursive: true });
    await applyFixtureSetup({
      fixtureId: 'proof/remove-link',
      operations: [
        {
          kind: 'directory-link',
          path: 'repo/linked',
          target: 'repo/target',
        },
        { kind: 'remove-path', path: 'repo/linked' },
      ],
      sandboxRoot,
    });

    expect(await pathExists(path.join(sandboxRoot, 'repo/linked'))).toBe(false);
    expect(await pathExists(path.join(sandboxRoot, 'repo/target'))).toBe(true);
  });

  it('protects repo and tool roots and includes operation context in failures', async () => {
    const sandboxRoot = await createTemporaryRoot('setup-protected');
    await mkdir(path.join(sandboxRoot, 'repo'), { recursive: true });
    await expect(
      applyFixtureSetup({
        fixtureId: 'proof/protected',
        operations: [{ kind: 'remove-path', path: 'repo' }],
        sandboxRoot,
      }),
    ).rejects.toThrow(
      'Detector fixture proof/protected setup operation 0 (remove-path) failed',
    );
    await expect(
      applyFixtureSetup({
        fixtureId: 'proof/protected',
        operations: [
          {
            content: 'unsafe',
            kind: 'write-file',
            path: 'repo/node_modules/unsafe.txt',
          },
        ],
        sandboxRoot,
      }),
    ).rejects.toThrow('harness-managed path repo/node_modules');
  });

  it('requires replace-text matches to exist and be unique by default', async () => {
    const sandboxRoot = await createTemporaryRoot('mutation-replace');
    await writeText(path.join(sandboxRoot, 'repo/value.txt'), 'one one');
    await expect(
      applyFixtureMutations({
        fixtureId: 'proof/mutation',
        mutations: [
          {
            kind: 'replace-text',
            path: 'repo/value.txt',
            replacement: 'two',
            search: 'missing',
          },
        ],
        sandboxRoot,
      }),
    ).rejects.toThrow('search was not found');
    await expect(
      applyFixtureMutations({
        fixtureId: 'proof/mutation',
        mutations: [
          {
            kind: 'replace-text',
            path: 'repo/value.txt',
            replacement: 'two',
            search: 'one',
          },
        ],
        sandboxRoot,
      }),
    ).rejects.toThrow('expected one match but found 2');

    await applyFixtureMutations({
      fixtureId: 'proof/mutation',
      mutations: [
        {
          all: true,
          kind: 'replace-text',
          path: 'repo/value.txt',
          replacement: 'two',
          search: 'one',
        },
      ],
      sandboxRoot,
    });
    expect(
      await readFile(path.join(sandboxRoot, 'repo/value.txt'), 'utf8'),
    ).toBe('two two');
  });

  it('treats a completed mutation state as the next explicit baseline', async () => {
    const sandboxRoot = await createTemporaryRoot('mutation-baseline');
    await writeText(path.join(sandboxRoot, 'repo/value.txt'), 'before');
    await applyFixtureMutations({
      fixtureId: 'proof/mutation-baseline',
      mutations: [
        {
          content: 'after',
          kind: 'write-file',
          path: 'repo/value.txt',
        },
      ],
      sandboxRoot,
    });
    const before = await captureTreeSnapshot({ rootDir: sandboxRoot });
    const after = await captureTreeSnapshot({ rootDir: sandboxRoot });
    expect(() =>
      assertTreeSnapshotUnchanged({
        after,
        before,
        label: 'mutation baseline',
      }),
    ).not.toThrow();
  });
});

describe('minimal tool bridge and invocation boundary', () => {
  it('bridges only declared TypeScript package metadata and executables', async () => {
    const rootDir = await createTemporaryRoot('tool-bridge');
    const repoRoot = path.join(rootDir, 'repo');
    await writeText(path.join(repoRoot, 'package.json'), '{"private":true}\n');
    const bridge = await createFixtureToolBridges({
      fixtureId: 'proof/tool',
      repoRoot,
      tools: ['typescript'],
    });
    const fixtureRequire = createRequire(path.join(repoRoot, 'package.json'));
    expect(
      toPortablePath(
        await realpath(fixtureRequire.resolve('typescript/package.json')),
      ),
    ).toBe(
      toPortablePath(
        await realpath(
          path.join(repoRoot, 'node_modules/typescript/package.json'),
        ),
      ),
    );
    expect(await pathExists(path.join(bridge.binDirectory, 'tsc'))).toBe(true);
    expect(await pathExists(path.join(bridge.binDirectory, 'tsc.cmd'))).toBe(
      true,
    );
    const hostTypeScriptManifest = createRequire(import.meta.url).resolve(
      'typescript/package.json',
    );
    const hostTypeScriptCompiler = await realpath(
      path.join(path.dirname(hostTypeScriptManifest), 'bin/tsc'),
    );
    expect(
      await readFile(path.join(bridge.binDirectory, 'tsc'), 'utf8'),
    ).toContain(hostTypeScriptCompiler);
    expect(
      await readFile(path.join(bridge.binDirectory, 'tsc.cmd'), 'utf8'),
    ).toContain(hostTypeScriptCompiler);
    expect(await readdir(path.join(repoRoot, 'node_modules'))).toEqual([
      '.bin',
      'typescript',
    ]);
    expect(await pathExists(path.join(repoRoot, 'node_modules/vue-tsc'))).toBe(
      false,
    );
  });

  it('bridges the declared npm package manifest linter without a shell', async () => {
    const rootDir = await createTemporaryRoot('lint-tool-bridge');
    const repoRoot = path.join(rootDir, 'repo');
    await writeText(path.join(repoRoot, 'package.json'), '{"private":true}\n');
    const bridge = await createFixtureToolBridges({
      fixtureId: 'release/manifest-lint',
      repoRoot,
      tools: ['npm-package-json-lint'],
    });
    const fixtureRequire = createRequire(path.join(repoRoot, 'package.json'));
    const lintModule = fixtureRequire('npm-package-json-lint') as {
      NpmPackageJsonLint?: unknown;
    };

    expect(typeof lintModule.NpmPackageJsonLint).toBe('function');
    expect(bridge.bridgedTools).toEqual(['npm-package-json-lint']);
    expect(await readdir(path.join(repoRoot, 'node_modules'))).toEqual([
      'npm-package-json-lint',
    ]);
  });

  it('reports missing and unsupported tools with fixture context', async () => {
    const rootDir = await createTemporaryRoot('tool-errors');
    const repoRoot = path.join(rootDir, 'repo');
    await writeText(path.join(repoRoot, 'package.json'), '{"private":true}\n');
    await expect(
      createFixtureToolBridges({
        fixtureId: 'proof/missing-tool',
        repoRoot,
        resolvePackageJson: () => {
          throw new Error('/missing/typescript/package.json');
        },
        tools: ['typescript'],
      }),
    ).rejects.toThrow(
      'Detector fixture proof/missing-tool could not resolve tool typescript',
    );
    await expect(
      createFixtureToolBridges({
        fixtureId: 'proof/unsupported-tool',
        repoRoot,
        tools: ['vue-tsc'],
      }),
    ).rejects.toThrow(
      'Only typescript and npm-package-json-lint are implemented',
    );
  });

  it('does not expose an undeclared tool or create a bridge implicitly', async () => {
    const rootDir = await createTemporaryRoot('tool-empty');
    const repoRoot = path.join(rootDir, 'repo');
    await writeText(path.join(repoRoot, 'package.json'), '{"private":true}\n');
    const bridge = await createFixtureToolBridges({
      fixtureId: 'proof/no-tools',
      repoRoot,
      tools: [],
    });

    expect(bridge.bridgedTools).toEqual([]);
    expect(await pathExists(path.join(repoRoot, 'node_modules'))).toBe(false);
  });

  it('builds a no-shell executable/argv spawn spec with isolated env', () => {
    const parentPath = process.env.PATH;
    const spec = createLiminaSpawnSpec({
      args: ['--config', '/fixture/config.mts', 'check', 'detector'],
      cwd: '/fixture/repo',
      env: { ONLY_FOR_CHILD: 'yes' },
      fixtureName: 'proof/invocation',
      inheritParentEnv: false,
    });

    expect(spec.executable).toBe(process.execPath);
    expect(spec.args).toEqual([
      liminaBinPath,
      '--config',
      '/fixture/config.mts',
      'check',
      'detector',
    ]);
    expect(spec.options.cwd).toBe('/fixture/repo');
    expect(spec.options.shell).toBe(false);
    expect(spec.options.env).toMatchObject({
      CI: 'true',
      FORCE_COLOR: '0',
      ONLY_FOR_CHILD: 'yes',
    });
    expect((spec.options.env as NodeJS.ProcessEnv).npm_config_user_agent).toBe(
      undefined,
    );
    expect(process.env.PATH).toBe(parentPath);
  });

  it('isolates HOME/cache and rejects PATH overrides without mutating process.env', async () => {
    const sandboxRoot = await createTemporaryRoot('invocation-env');
    const parentEnvironment = { ...process.env };
    const environment = await createDetectorInvocationEnvironment({
      fixtureEnvironment: { FIXTURE_FLAG: 'enabled' },
      sandboxRoot,
      toolBinDirectory: path.join(sandboxRoot, 'repo/node_modules/.bin'),
    });

    expect(toPortablePath(environment.HOME ?? '')).toBe(
      toPortablePath(path.join(sandboxRoot, 'home')),
    );
    expect(toPortablePath(environment.XDG_CACHE_HOME ?? '')).toBe(
      toPortablePath(path.join(sandboxRoot, 'cache')),
    );
    expect(environment.FIXTURE_FLAG).toBe('enabled');
    expect(environment.NODE_PATH).toBeUndefined();
    expect(process.env).toEqual(parentEnvironment);
    await expect(
      createDetectorInvocationEnvironment({
        fixtureEnvironment: { PATH: '/unsafe' },
        sandboxRoot,
        toolBinDirectory: path.join(sandboxRoot, 'repo/node_modules/.bin'),
      }),
    ).rejects.toThrow('cannot override harness variable PATH');
  });
});

describe('formal structured snapshot reader', () => {
  it('reads a current completed snapshot through the product reader', async () => {
    const repoRoot = await createTemporaryRoot('snapshot-valid');
    const startedAt = Date.now() - 10;
    await writeSnapshot(repoRoot, validSnapshot());

    await expect(
      readDetectorCheckSnapshot({
        command: ['check', 'detector'],
        fixtureId: 'proof/snapshot',
        invocationStartedAtMs: startedAt,
        repoRoot,
      }),
    ).resolves.toMatchObject({
      command: 'limina check detector',
      status: 'completed',
      version: CHECK_ISSUE_SNAPSHOT_VERSION,
    });
  });

  it('distinguishes missing, invalid JSON, and invalid schema snapshots', async () => {
    const missingRoot = await createTemporaryRoot('snapshot-missing');
    await expect(
      readDetectorCheckSnapshot({
        command: ['check', 'detector'],
        fixtureId: 'proof/missing',
        invocationStartedAtMs: Date.now(),
        repoRoot: missingRoot,
      }),
    ).rejects.toThrow('did not produce structured snapshot');

    const invalidJsonRoot = await createTemporaryRoot('snapshot-json');
    await writeText(getCheckIssueSnapshotPath(invalidJsonRoot), '{invalid');
    await expect(
      readDetectorCheckSnapshot({
        command: ['check', 'detector'],
        fixtureId: 'proof/json',
        invocationStartedAtMs: Date.now(),
        repoRoot: invalidJsonRoot,
      }),
    ).rejects.toThrow('produced invalid JSON');

    const invalidSchemaRoot = await createTemporaryRoot('snapshot-schema');
    await writeSnapshot(invalidSchemaRoot, {
      ...validSnapshot(),
      version: 999,
    });
    await expect(
      readDetectorCheckSnapshot({
        command: ['check', 'detector'],
        fixtureId: 'proof/schema',
        invocationStartedAtMs: Date.now(),
        repoRoot: invalidSchemaRoot,
      }),
    ).rejects.toThrow('formal current check schema');
  });

  it('rejects preexisting, stale, and wrong-command snapshots', async () => {
    const staleRoot = await createTemporaryRoot('snapshot-stale');
    await writeSnapshot(staleRoot, validSnapshot());
    await expect(assertNoPreexistingCheckSnapshot(staleRoot)).rejects.toThrow(
      'stale structured snapshot before invocation',
    );
    await expect(
      readDetectorCheckSnapshot({
        command: ['check', 'detector'],
        fixtureId: 'proof/stale',
        invocationStartedAtMs: Date.now() + 5000,
        repoRoot: staleRoot,
      }),
    ).rejects.toThrow('structured snapshot is stale');

    const commandRoot = await createTemporaryRoot('snapshot-command');
    await writeSnapshot(commandRoot, validSnapshot('limina check other'));
    await expect(
      readDetectorCheckSnapshot({
        command: ['check', 'detector'],
        fixtureId: 'proof/command',
        invocationStartedAtMs: Date.now() - 10,
        repoRoot: commandRoot,
      }),
    ).rejects.toThrow('snapshot command mismatch');
  });

  it('reads one current standalone checker invocation through the product reader', async () => {
    const repoRoot = await createTemporaryRoot('snapshot-standalone');
    const startedAt = Date.now() - 10;
    const snapshotPath = await writeStandaloneInvocationSnapshot(repoRoot);

    await expect(
      readDetectorStructuredSnapshot({
        command: [
          'checker',
          'build',
          'packages/app/tsconfig.json',
          '--preset',
          'tsgo',
        ],
        fixtureId: 'checker/target-selection',
        invocationStartedAtMs: startedAt,
        repoRoot,
      }),
    ).resolves.toMatchObject({
      kind: 'standalone-invocation',
      snapshot: {
        command: 'limina checker build',
        issues: [
          expect.objectContaining({
            code: LIMINA_CHECK_ISSUE_CODES.checkerTargetSelectionFailed,
            task: 'checker:build',
          }),
        ],
        status: 'completed',
      },
      snapshotPath,
    });
  });

  it('rejects stale standalone invocations and unsupported standalone commands', async () => {
    const repoRoot = await createTemporaryRoot('snapshot-standalone-stale');
    await writeStandaloneInvocationSnapshot(repoRoot);

    await expect(
      assertNoPreexistingDetectorSnapshots(repoRoot),
    ).rejects.toThrow('stale standalone invocation snapshots');
    await expect(
      readDetectorStructuredSnapshot({
        command: ['build', 'packages/app/tsconfig.json'],
        fixtureId: 'checker/unsupported-command',
        invocationStartedAtMs: Date.now(),
        repoRoot,
      }),
    ).rejects.toThrow(
      'does not produce a supported formal structured snapshot',
    );
  });
});

describe('strict structured issue assertion', () => {
  const firstExpected: ExpectedIssue = {
    code: LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile,
    filePath: 'packages/pkg/first.ts',
    task: 'proof:check',
  };
  const secondExpected: ExpectedIssue = {
    code: LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile,
    filePath: 'packages/pkg/second.ts',
    task: 'proof:check',
  };

  it('matches out of order and distinguishes identical codes by path', () => {
    expect(() =>
      assertDetectorIssues({
        actualIssues: [
          actualIssue({ filePath: 'packages/pkg/second.ts' }),
          actualIssue({ filePath: 'packages/pkg/first.ts' }),
        ],
        expected: expectedFailure([firstExpected, secondExpected]),
        fixtureId: 'proof/issues',
        repoRoot: '/repo',
      }),
    ).not.toThrow();
  });

  it('rejects missing, unexpected, reused, and ambiguous issues', () => {
    expect(() =>
      assertDetectorIssues({
        actualIssues: [],
        expected: expectedFailure([firstExpected]),
        fixtureId: 'proof/missing',
        repoRoot: '/repo',
      }),
    ).toThrow('missing an expected issue');
    expect(() =>
      assertDetectorIssues({
        actualIssues: [
          actualIssue({ filePath: 'packages/pkg/first.ts' }),
          actualIssue({
            code: LIMINA_CHECK_ISSUE_CODES.graphReferenceMissing,
            filePath: 'packages/pkg/tsconfig.json',
            task: 'graph:check',
          }),
        ],
        expected: expectedFailure([firstExpected]),
        fixtureId: 'proof/unexpected',
        repoRoot: '/repo',
      }),
    ).toThrow('produced undeclared issues');
    expect(() =>
      assertDetectorIssues({
        actualIssues: [actualIssue({ filePath: 'packages/pkg/first.ts' })],
        expected: expectedFailure([firstExpected, firstExpected]),
        fixtureId: 'proof/reused',
        repoRoot: '/repo',
      }),
    ).toThrow('missing an expected issue');
    expect(() =>
      assertDetectorIssues({
        actualIssues: [actualIssue(), actualIssue({ id: 'other-id' })],
        expected: expectedFailure([
          {
            code: LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile,
            task: 'proof:check',
          },
        ]),
        fixtureId: 'proof/ambiguous',
        repoRoot: '/repo',
      }),
    ).toThrow('ambiguous expected issue');
  });

  it('normalizes Windows paths and ignores title and issue ID', () => {
    expect(() =>
      assertDetectorIssues({
        actualIssues: [
          actualIssue({
            filePath: String.raw`packages\pkg\uncovered.ts`,
            id: 'changed-id',
            title: 'rewritten presentation',
          }),
        ],
        expected: expectedFailure([
          {
            code: LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile,
            filePath: 'packages/pkg/uncovered.ts',
            task: 'proof:check',
          },
        ]),
        fixtureId: 'proof/portable',
        repoRoot: '/repo',
      }),
    ).not.toThrow();
  });

  it('matches structured external codes and evidence subsets', () => {
    expect(() =>
      assertDetectorIssues({
        actualIssues: [
          actualIssue({
            evidence: [
              { label: 'source', value: 'packages/pkg/uncovered.ts' },
              { label: 'extra', value: 'ignored' },
            ],
            external: { code: 'TS9999', tool: 'typescript' },
          }),
        ],
        expected: expectedFailure([
          {
            code: LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile,
            evidence: [{ label: 'source', value: 'packages/pkg/uncovered.ts' }],
            externalCode: 'TS9999',
            filePath: 'packages/pkg/uncovered.ts',
            task: 'proof:check',
          },
        ]),
        fixtureId: 'proof/evidence',
        repoRoot: '/repo',
      }),
    ).not.toThrow();
  });

  it('distinguishes same-code findings by their structured reason', () => {
    expect(() =>
      assertDetectorIssues({
        actualIssues: [actualIssue({ reason: 'content-diff' })],
        expected: expectedFailure([
          {
            code: LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile,
            reason: 'config-invalid',
            task: 'proof:check',
          },
        ]),
        fixtureId: 'release/reason-mismatch',
        repoRoot: '/repo',
      }),
    ).toThrow('missing an expected issue');
    expect(() =>
      assertDetectorIssues({
        actualIssues: [actualIssue({ reason: 'config-invalid' })],
        expected: expectedFailure([
          {
            code: LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile,
            reason: 'config-invalid',
            task: 'proof:check',
          },
        ]),
        fixtureId: 'release/reason-match',
        repoRoot: '/repo',
      }),
    ).not.toThrow();
  });

  it('matches a structured scope without parsing presentation text', () => {
    expect(() =>
      assertDetectorIssues({
        actualIssues: [
          actualIssue({
            filePath: undefined,
            scope: 'source.importAuthority.allow["@fixture/missing"]',
          }),
        ],
        expected: expectedFailure([
          {
            code: LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile,
            scope: 'source.importAuthority.allow["@fixture/missing"]',
            task: 'proof:check',
          },
        ]),
        fixtureId: 'source/scope',
        repoRoot: '/repo',
      }),
    ).not.toThrow();
  });

  it('matches structured location subsets with portable paths', () => {
    expect(() =>
      assertDetectorIssues({
        actualIssues: [
          actualIssue({
            filePath: undefined,
            locations: [
              {
                filePath: '/repo/packages/pkg/fixtures/covered.ts',
                label: 'source or covering project',
              },
              {
                filePath: '/repo/packages/pkg/tsconfig.json',
                label: 'source or covering project',
              },
            ],
          }),
        ],
        expected: expectedFailure([
          {
            code: LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile,
            locations: [
              {
                filePath: 'packages/pkg/fixtures/covered.ts',
                label: 'source or covering project',
              },
            ],
            task: 'proof:check',
          },
        ]),
        fixtureId: 'proof/locations',
        repoRoot: '/repo',
      }),
    ).not.toThrow();
  });

  it('allows only declared additional codes and reports truncated leftovers', () => {
    const cascade = actualIssue({
      code: LIMINA_CHECK_ISSUE_CODES.graphReferenceMissing,
      filePath: 'packages/pkg/tsconfig.json',
      task: 'graph:check',
    });
    expect(() =>
      assertDetectorIssues({
        actualIssues: [actualIssue(), cascade],
        expected: expectedFailure(
          [
            {
              code: LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile,
              filePath: 'packages/pkg/uncovered.ts',
              task: 'proof:check',
            },
          ],
          { additionalCodes: [LIMINA_CHECK_ISSUE_CODES.graphReferenceMissing] },
        ),
        fixtureId: 'proof/additional',
        repoRoot: '/repo',
      }),
    ).not.toThrow();

    const leftovers = Array.from({ length: 22 }, (_, index) =>
      actualIssue({ filePath: `packages/pkg/extra-${index}.ts` }),
    );
    expect(() =>
      assertDetectorIssues({
        actualIssues: leftovers,
        expected: expectedFailure([], {
          primaryCode: undefined,
        }),
        fixtureId: 'proof/truncated',
        repoRoot: '/repo',
      }),
    ).toThrow('2 more issues omitted');
  });
});

describe('deterministic Release tarballs and local registry', () => {
  const packageFiles = [
    { content: 'MIT\n', path: 'LICENSE.md' },
    { content: '# Fixture\n', path: 'README.md' },
    { content: 'export const value = 1;\n', path: 'index.js' },
    {
      content: `${JSON.stringify({
        license: 'MIT',
        name: '@fixture/dependency',
        version: '1.0.0',
      })}\n`,
      path: 'package.json',
    },
  ] as const;

  it('packs fixed file bytes reproducibly through the production pack helper', async () => {
    const tempRoot = await createTemporaryRoot('deterministic-tarball');
    const first = await createDeterministicPackageTarball({
      files: packageFiles,
      tempRoot,
    });
    const second = await createDeterministicPackageTarball({
      files: packageFiles.toReversed(),
      tempRoot,
    });

    expect(first.bytes.equals(second.bytes)).toBe(true);
    expect(first.integrity).toBe(second.integrity);
    expect(first.shasum).toBe(second.shasum);
    expect(first.integrity).toBe(
      `sha512-${createHash('sha512').update(first.bytes).digest('base64')}`,
    );
    expect(first.shasum).toBe(
      createHash('sha1').update(first.bytes).digest('hex'),
    );
    const unpacked = (await unpack(first.bytes)) as {
      readonly files: readonly { readonly name: string }[];
    };
    expect(unpacked.files.map((file) => file.name)).toEqual(
      expect.arrayContaining(['package/index.js', 'package/package.json']),
    );
  });

  it('serves generated metadata and tarballs on isolated random loopback ports', async () => {
    const tempRoot = await createTemporaryRoot('registry-serve');
    const tarballPath = '/tarballs/dependency-1.0.0.tgz';
    const scenario = {
      expectedRequests: [
        {
          headers: { accept: 'application/json' },
          pathname: '/%40fixture%2Fdependency',
        },
        {
          headers: { accept: 'application/octet-stream' },
          pathname: tarballPath,
        },
      ],
      metadata: {
        body: {
          integrity: { kind: 'actual' },
          kind: 'package-metadata',
          tarballPath,
          version: '1.0.0',
        },
      },
      packageName: '@fixture/dependency',
      tarballs: {
        [tarballPath]: {
          body: { files: packageFiles, kind: 'package-tarball' },
        },
      },
    } as const;
    const first = await startLocalRegistryFixture({ scenario, tempRoot });
    const second = await startLocalRegistryFixture({ scenario, tempRoot });

    try {
      expect(first.baseUrl.hostname).toBe('127.0.0.1');
      expect(first.baseUrl.port).not.toBe(second.baseUrl.port);
      const metadataResponse = await fetch(
        new URL('/%40fixture%2Fdependency', first.baseUrl),
        { headers: { accept: 'application/json' } },
      );
      const metadata = (await metadataResponse.json()) as {
        versions: Record<
          string,
          { dist: { integrity: string; tarball: string } }
        >;
      };
      const dist = metadata.versions['1.0.0']!.dist;
      const tarballResponse = await fetch(dist.tarball, {
        headers: { accept: 'application/octet-stream' },
      });
      const tarball = Buffer.from(await tarballResponse.arrayBuffer());

      expect(dist.tarball).toBe(new URL(tarballPath, first.baseUrl).toString());
      expect(dist.integrity).toBe(
        `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
      );
      expect(() =>
        assertLocalRegistryRequests({
          actual: first.requests,
          expected: scenario.expectedRequests,
          fixtureId: 'release/registry-helper',
        }),
      ).not.toThrow();
      expect(second.requests).toEqual([]);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('provides deterministic connection-close and incomplete-body failures', async () => {
    const tempRoot = await createTemporaryRoot('registry-failures');
    const closeFixture = await startLocalRegistryFixture({
      scenario: {
        expectedRequests: [],
        metadata: { body: { kind: 'close-connection' } },
        packageName: '@fixture/close',
      },
      tempRoot,
    });
    const incompleteFixture = await startLocalRegistryFixture({
      scenario: {
        expectedRequests: [],
        metadata: {
          body: { kind: 'incomplete-body', value: '{"partial":' },
        },
        packageName: '@fixture/incomplete',
      },
      tempRoot,
    });

    try {
      await expect(
        fetch(new URL('/%40fixture%2Fclose', closeFixture.baseUrl)),
      ).rejects.toThrow();
      const response = await fetch(
        new URL('/%40fixture%2Fincomplete', incompleteFixture.baseUrl),
      );
      await expect(response.text()).rejects.toThrow();
      expect(closeFixture.requests).toHaveLength(1);
      expect(incompleteFixture.requests).toHaveLength(1);
    } finally {
      await closeFixture.close();
      await incompleteFixture.close();
    }
  });
});

describe('source invariant and cleanup', () => {
  it('detects modified, added, and deleted inputs without using mtime', async () => {
    const rootDir = await createTemporaryRoot('invariant');
    const filePath = path.join(rootDir, 'source.ts');
    await writeText(filePath, 'original');
    const before = await captureTreeSnapshot({ rootDir });

    await utimes(filePath, new Date(), new Date(Date.now() + 1000));
    const afterMtime = await captureTreeSnapshot({ rootDir });
    expect(() =>
      assertTreeSnapshotUnchanged({
        after: afterMtime,
        before,
        label: 'mtime invariant',
      }),
    ).not.toThrow();

    await writeText(filePath, 'modified');
    await writeText(path.join(rootDir, 'added.ts'), 'added');
    const afterModified = await captureTreeSnapshot({ rootDir });
    expect(() =>
      assertTreeSnapshotUnchanged({
        after: afterModified,
        before,
        label: 'modified invariant',
      }),
    ).toThrow(/modified source\.ts[\s\S]*added added\.ts/u);

    await rm(filePath);
    const afterDeleted = await captureTreeSnapshot({ rootDir });
    expect(() =>
      assertTreeSnapshotUnchanged({
        after: afterDeleted,
        before,
        label: 'deleted invariant',
      }),
    ).toThrow('deleted source.ts');
  });

  it('allows generated additions without masking input modifications', async () => {
    const rootDir = await createTemporaryRoot('invariant-allowed');
    await writeText(path.join(rootDir, 'repo/source.ts'), 'original');
    const before = await captureTreeSnapshot({ rootDir });
    await writeText(path.join(rootDir, 'repo/dist/output.js'), 'generated');
    const generatedAfter = await captureTreeSnapshot({ rootDir });
    expect(() =>
      assertTreeSnapshotUnchanged({
        after: generatedAfter,
        allowedAddedPaths: ['repo/dist/**'],
        before,
        label: 'allowed generated output',
      }),
    ).not.toThrow();

    await writeText(path.join(rootDir, 'repo/source.ts'), 'modified');
    const modifiedAfter = await captureTreeSnapshot({ rootDir });
    expect(() =>
      assertTreeSnapshotUnchanged({
        after: modifiedAfter,
        allowedAddedPaths: ['repo/**'],
        before,
        label: 'allowed generated output',
      }),
    ).toThrow('modified repo/source.ts');
  });

  it('ignores only harness-owned .limina and tool bridge paths', async () => {
    const rootDir = await createTemporaryRoot('invariant-managed');
    await writeText(path.join(rootDir, 'repo/source.ts'), 'source');
    const before = await captureTreeSnapshot({
      ignoredPathPrefixes: DEFAULT_SANDBOX_IGNORED_PATH_PREFIXES,
      rootDir,
    });
    await writeText(path.join(rootDir, 'repo/.limina/check/result.json'), '{}');
    await writeText(path.join(rootDir, 'repo/node_modules/.bin/tsc'), 'shim');
    const after = await captureTreeSnapshot({
      ignoredPathPrefixes: DEFAULT_SANDBOX_IGNORED_PATH_PREFIXES,
      rootDir,
    });
    expect(() =>
      assertTreeSnapshotUnchanged({
        after,
        before,
        label: 'managed output invariant',
      }),
    ).not.toThrow();
  });

  it('copies without writing back to the source fixture', async () => {
    const rootDir = await createTemporaryRoot('source-unchanged');
    const sourceRoot = path.join(rootDir, 'source');
    await writeText(path.join(sourceRoot, 'source.ts'), 'source');
    const before = await captureTreeSnapshot({ rootDir: sourceRoot });
    await copyFixtureRepository({
      destinationRoot: path.join(rootDir, 'destination'),
      sourceRoot,
    });
    const after = await captureTreeSnapshot({ rootDir: sourceRoot });
    expect(() =>
      assertTreeSnapshotUnchanged({
        after,
        before,
        label: 'fixture source',
      }),
    ).not.toThrow();
  });

  it('creates unique parallel sandboxes and cleans only contained paths', async () => {
    const tempRoot = await createTemporaryRoot('cleanup-unique');
    const first = await createDetectorSandbox({
      fixtureId: 'proof/parallel',
      tempRoot,
    });
    const second = await createDetectorSandbox({
      fixtureId: 'proof/parallel',
      tempRoot,
    });
    expect(first.sandboxRoot).not.toBe(second.sandboxRoot);
    expect(path.basename(first.sandboxRoot)).toContain('proof-parallel');
    await cleanupDetectorSandbox(first);
    expect(await pathExists(first.sandboxRoot)).toBe(false);
    expect(await pathExists(second.sandboxRoot)).toBe(true);

    const outsideRoot = await createTemporaryRoot('cleanup-outside');
    await expect(
      cleanupDetectorSandbox({
        sandboxRoot: outsideRoot,
        tempRoot,
      }),
    ).rejects.toThrow('outside the integration temp root');
  });

  it('bounds long sandbox names for cross-platform child IPC paths', async () => {
    const tempRoot = await createTemporaryRoot('cleanup-long-name');
    const sandbox = await createDetectorSandbox({
      fixtureId:
        'release/packed-source-workspace-dependency-missing-with-extra-context',
      tempRoot,
    });

    expect(path.basename(sandbox.sandboxRoot).length).toBeLessThanOrEqual(40);
    await cleanupDetectorSandbox(sandbox);
  });

  it('preserves on request and passes bounded Windows retry options', async () => {
    const tempRoot = await createTemporaryRoot('cleanup-preserve');
    const preserved = await createDetectorSandbox({
      fixtureId: 'proof/preserve',
      tempRoot,
    });
    await expect(
      cleanupDetectorSandbox({ ...preserved, preserve: true }),
    ).resolves.toBe(false);
    expect(await pathExists(preserved.sandboxRoot)).toBe(true);

    const retrySandbox = await createDetectorSandbox({
      fixtureId: 'proof/retry',
      tempRoot,
    });
    const remove = vi.fn(async () => {});
    await cleanupDetectorSandbox(retrySandbox, { remove });
    // Cleanup canonicalizes the sandbox path (forward slashes) before handing
    // it to `rm`, so assert against the portable form rather than the raw
    // backslash path a Windows fixture would carry.
    expect(remove).toHaveBeenCalledWith(
      toPortablePath(retrySandbox.sandboxRoot),
      {
        force: true,
        maxRetries: SANDBOX_CLEANUP_MAX_RETRIES,
        recursive: true,
        retryDelay: SANDBOX_CLEANUP_RETRY_DELAY_MS,
      },
    );
  });

  it('does not follow a sandbox link while recursively cleaning', async () => {
    const tempRoot = await createTemporaryRoot('cleanup-link');
    const externalRoot = await createTemporaryRoot('cleanup-link-target');
    await writeText(path.join(externalRoot, 'sentinel.txt'), 'keep');
    const sandbox = await createDetectorSandbox({
      fixtureId: 'proof/cleanup-link',
      tempRoot,
    });
    await symlink(
      externalRoot,
      path.join(sandbox.sandboxRoot, 'external-link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await cleanupDetectorSandbox(sandbox);

    expect(await pathExists(path.join(externalRoot, 'sentinel.txt'))).toBe(
      true,
    );
  });

  it('keeps primary failure precedence and fails on cleanup-only errors', async () => {
    await expect(
      finishFixtureCleanup({
        cleanup: async () => {
          throw new Error('cleanup detail');
        },
        primaryError: new Error('primary detail'),
      }),
    ).rejects.toThrow(/primary detail[\s\S]*Cleanup failure: cleanup detail/u);
    await expect(
      finishFixtureCleanup({
        cleanup: async () => {
          throw new Error('cleanup only');
        },
      }),
    ).rejects.toThrow('cleanup only');
  });
});
