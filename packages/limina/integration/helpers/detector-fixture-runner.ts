import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type CheckIssueSnapshot,
  getCheckIssueSnapshotPath,
  type LiminaCheckRunSummary,
} from '../../src/check-reporting/snapshot';
import {
  INTERNAL_RELEASE_REGISTRY_TIMEOUT_ENV,
  INTERNAL_RELEASE_REGISTRY_URL_ENV,
} from '../../src/package-check/release-registry-test-seam';
import { createDetectorInvocationEnvironment } from './detector-environment';
import type { DetectorFixtureCase } from './detector-fixture-discovery';
import type { DetectorStructuredSnapshotKind } from './detector-snapshot';
import {
  assertNoPreexistingDetectorSnapshots,
  getDetectorStructuredSnapshotKind,
  readDetectorStructuredSnapshot,
} from './detector-snapshot';
import {
  applyFixtureSetup,
  assertTreeSnapshotUnchanged,
  captureTreeSnapshot,
  cleanupDetectorSandbox,
  copyFixtureRepository,
  createDetectorSandbox,
  DEFAULT_SANDBOX_IGNORED_PATH_PREFIXES,
  finishFixtureCleanup,
  pathExists,
  PRESERVE_INTEGRATION_ARTIFACTS_ENV,
} from './fixture-sandbox';
import { assertDetectorIssues } from './issue-assertions';
import {
  assertLocalRegistryRequests,
  type LocalRegistryFixture,
  type RecordedRegistryRequest,
  startLocalRegistryFixture,
} from './local-registry';
import { materializeReleaseFixtureOutputs } from './release-fixture-output';
import { liminaBinPath, runLimina, type RunLiminaResult } from './run-limina';
import { createFixtureToolBridges } from './tool-bridge';

const OUTPUT_DIAGNOSTIC_LIMIT = 4000;
const faultLauncherPath = fileURLToPath(
  new URL('fault-injection-launcher.ts', import.meta.url),
);
const tsxLoaderPath = createRequire(import.meta.url).resolve('tsx');

interface FaultInjectionReceipt {
  readonly boundary?: {
    readonly cleanupDescriptorCount: number;
    readonly cleanupDirectoryDescriptorCount: number;
    readonly cleanupFileDescriptorCount: number;
    readonly cleanupGenerationCount: number;
    readonly cleanupResourcesRemoved: number;
    readonly flowCleanupAttempts: number;
    readonly flowCleanupCompleted: boolean;
    readonly flowResourcesClosed: boolean;
    readonly removedTempFiles: number;
    readonly tempCleanupAttempts: number;
    readonly tempCleanupCompleted: boolean;
  };
  readonly error?: {
    readonly code?: string;
    readonly message: string;
    readonly name: string;
  };
  readonly execution?: {
    readonly issues: CheckIssueSnapshot['issues'];
    readonly outcome: { readonly state: string };
  };
  readonly fixtureId: string;
  readonly observations: readonly {
    readonly consumed: boolean;
    readonly expectedOccurrence: number;
    readonly id: string;
    readonly observedOccurrences: number;
    readonly point: string;
    readonly task: string;
  }[];
  readonly run?: LiminaCheckRunSummary;
  readonly version: number;
}

export interface DetectorFixtureRunResult {
  readonly cleaned: boolean;
  readonly cli: RunLiminaResult;
  readonly fixtureId: string;
  readonly preserved: boolean;
  readonly registry?: {
    readonly baseUrl: string;
    readonly requests: readonly RecordedRegistryRequest[];
  };
  readonly sandboxRoot: string;
  readonly snapshot?: CheckIssueSnapshot;
  readonly snapshotPath: string;
}

export function assertExecutableDetectorFixtureKind(
  fixture: Pick<DetectorFixtureCase, 'definition' | 'id'>,
): void {
  const kind: string = fixture.definition.kind;
  if (
    kind !== 'filesystem' &&
    kind !== 'external-tool' &&
    kind !== 'fault-injection'
  ) {
    throw new Error(
      `Detector fixture ${fixture.id} uses ${kind}; harness v2 executes filesystem, external-tool, and fault-injection fixtures.`,
    );
  }
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncateOutput(value: string): string {
  if (value.length <= OUTPUT_DIAGNOSTIC_LIMIT) {
    return value;
  }

  return `${value.slice(0, OUTPUT_DIAGNOSTIC_LIMIT)}\n... truncated ${value.length - OUTPUT_DIAGNOSTIC_LIMIT} characters`;
}

function combineErrors(primary: unknown, secondary: unknown): Error {
  return new Error(
    `${formatUnknownError(primary)}\nAdditional invariant failure: ${formatUnknownError(secondary)}`,
    { cause: primary },
  );
}

function contextualizeFailure(options: {
  readonly casePath: string;
  readonly cli?: RunLiminaResult;
  readonly error: unknown;
  readonly entry?: {
    readonly args: readonly string[];
    readonly executable: string;
  };
  readonly fixtureId: string;
  readonly invocationArgs: readonly string[];
  readonly repoRoot: string;
  readonly sandboxRoot: string;
  readonly snapshotPath: string;
}): Error {
  const entry = options.entry ?? {
    args: [liminaBinPath],
    executable: process.execPath,
  };
  return new Error(
    [
      `Detector fixture ${options.fixtureId} failed: ${formatUnknownError(options.error)}`,
      `case: ${options.casePath}`,
      `sandbox: ${options.sandboxRoot}`,
      `cwd: ${options.repoRoot}`,
      `executable: ${entry.executable}`,
      `argv: ${JSON.stringify([...entry.args, ...options.invocationArgs])}`,
      `exit code: ${String(options.cli?.code ?? 'unavailable')}`,
      `signal: ${String(options.cli?.signal ?? 'unavailable')}`,
      `timed out: ${String(options.cli?.timedOut ?? false)}`,
      `structured snapshot: ${options.snapshotPath}`,
      `${PRESERVE_INTEGRATION_ARTIFACTS_ENV}=1 preserves this sandbox for inspection.`,
      `stdout:\n${truncateOutput(options.cli?.stdout ?? '')}`,
      `stderr:\n${truncateOutput(options.cli?.stderr ?? '')}`,
    ].join('\n'),
    { cause: options.error },
  );
}

async function requireConfigFile(configPath: string, fixtureId: string) {
  const configStat = await lstat(configPath);
  if (!configStat.isFile() || configStat.isSymbolicLink()) {
    throw new Error(
      `Detector fixture ${fixtureId} must provide a real repo/limina.config.mts file: ${configPath}`,
    );
  }
}

function assertCliResult(options: {
  readonly expectedExitCode: number;
  readonly fixtureId: string;
  readonly result: RunLiminaResult;
}): void {
  if (options.result.timedOut) {
    throw new Error(`Detector fixture ${options.fixtureId} CLI timed out.`);
  }
  if (options.result.signal !== null) {
    throw new Error(
      `Detector fixture ${options.fixtureId} CLI terminated by signal ${options.result.signal}.`,
    );
  }
  if (options.result.code !== options.expectedExitCode) {
    throw new Error(
      `Detector fixture ${options.fixtureId} exit code mismatch: expected ${options.expectedExitCode}, received ${String(options.result.code)}.`,
    );
  }
}

function assertSnapshotOutcome(options: {
  readonly expectedExitCode: number;
  readonly expectedRunOutcome?: string;
  readonly fixtureId: string;
  readonly kind: DetectorStructuredSnapshotKind;
  readonly snapshot: CheckIssueSnapshot;
}): void {
  if (options.kind === 'standalone-invocation') {
    if (options.expectedExitCode === 0) {
      throw new Error(
        `Detector fixture ${options.fixtureId} expected a successful standalone invocation, but formal standalone snapshots record failures only.`,
      );
    }
    if (options.snapshot.status !== 'completed') {
      throw new Error(
        `Detector fixture ${options.fixtureId} standalone invocation snapshot is not completed.`,
      );
    }
    return;
  }

  const runResult = options.snapshot.run?.result;
  if (options.expectedRunOutcome !== undefined) return;
  if (options.expectedExitCode === 0 && runResult !== 'passed') {
    throw new Error(
      `Detector fixture ${options.fixtureId} exited successfully but structured run result is ${String(runResult)}.`,
    );
  }
  if (options.expectedExitCode !== 0 && runResult === 'passed') {
    throw new Error(
      `Detector fixture ${options.fixtureId} exited unsuccessfully but structured run result is passed.`,
    );
  }
}

export function assertExpectedRunState(options: {
  readonly fixture: DetectorFixtureCase;
  readonly run: LiminaCheckRunSummary | undefined;
}): void {
  const expected = options.fixture.definition.expected;
  if (
    expected.runOutcome !== undefined &&
    options.run?.result !== expected.runOutcome
  ) {
    throw new Error(
      `Detector fixture ${options.fixture.id} run outcome mismatch: expected ${expected.runOutcome}, received ${String(options.run?.result)}.`,
    );
  }

  for (const [task, expectedState] of Object.entries(
    expected.taskStates ?? {},
  )) {
    const matches =
      options.run?.tasks.filter((entry) => entry.issueTask === task) ?? [];
    if (matches.length !== 1) {
      throw new Error(
        `Detector fixture ${options.fixture.id} expected one ${task} task state, received ${matches.length}.`,
      );
    }
    if (matches[0]!.state !== expectedState) {
      throw new Error(
        `Detector fixture ${options.fixture.id} task ${task} state mismatch: expected ${expectedState}, received ${matches[0]!.state}.`,
      );
    }
  }
}

export function assertLinesInOrder(options: {
  readonly fixtureId: string;
  readonly label: 'stderr' | 'stdout';
  readonly lines: readonly string[] | undefined;
  readonly output: string;
}): void {
  let cursor = 0;
  for (const line of options.lines ?? []) {
    const index = options.output.indexOf(line, cursor);
    if (index === -1) {
      throw new Error(
        `Detector fixture ${options.fixtureId} ${options.label} is missing an expected in-stream sequence entry after offset ${cursor}: ${JSON.stringify(line)}.`,
      );
    }
    cursor = index + line.length;
  }
}

async function readFaultReceipt(options: {
  readonly fixtureId: string;
  readonly receiptPath: string;
}): Promise<FaultInjectionReceipt> {
  let receipt: FaultInjectionReceipt;
  try {
    receipt = JSON.parse(
      await readFile(options.receiptPath, 'utf8'),
    ) as FaultInjectionReceipt;
  } catch (error) {
    throw new Error(
      `Fault fixture ${options.fixtureId} did not produce a valid consumption receipt at ${options.receiptPath}: ${formatUnknownError(error)}`,
      { cause: error },
    );
  }
  if (receipt.version !== 1 || receipt.fixtureId !== options.fixtureId) {
    throw new Error(
      `Fault fixture ${options.fixtureId} produced a mismatched consumption receipt.`,
    );
  }
  const unconsumed = receipt.observations.filter(
    (observation) => !observation.consumed,
  );
  if (unconsumed.length > 0) {
    throw new Error(
      [
        `Fault fixture ${options.fixtureId} did not consume every declared fault.`,
        ...unconsumed.map(
          (observation) =>
            `${observation.id}: point=${observation.point} task=${observation.task} expected occurrence=${observation.expectedOccurrence} observed=${observation.observedOccurrences}`,
        ),
      ].join('\n'),
    );
  }
  return receipt;
}

function assertFaultReceiptExpectation(options: {
  readonly fixture: DetectorFixtureCase;
  readonly receipt: FaultInjectionReceipt;
}): void {
  const expected = options.fixture.definition.expected;
  if (expected.error) {
    if (expected.error.expected !== Boolean(options.receipt.error)) {
      throw new Error(
        `Fault fixture ${options.fixture.id} launcher error presence mismatch: expected ${expected.error.expected}, received ${Boolean(options.receipt.error)}.`,
      );
    }
    if (
      expected.error.code !== undefined &&
      options.receipt.error?.code !== expected.error.code
    ) {
      throw new Error(
        `Fault fixture ${options.fixture.id} launcher error code mismatch: expected ${expected.error.code}, received ${String(options.receipt.error?.code)}.`,
      );
    }
    if (
      expected.error.name !== undefined &&
      options.receipt.error?.name !== expected.error.name
    ) {
      throw new Error(
        `Fault fixture ${options.fixture.id} launcher error name mismatch: expected ${expected.error.name}, received ${String(options.receipt.error?.name)}.`,
      );
    }
  }

  for (const [key, expectedValue] of Object.entries(expected.boundary ?? {})) {
    const actualValue =
      options.receipt.boundary?.[
        key as keyof NonNullable<FaultInjectionReceipt['boundary']>
      ];
    if (actualValue !== expectedValue) {
      throw new Error(
        `Fault fixture ${options.fixture.id} boundary ${key} mismatch: expected ${String(expectedValue)}, received ${String(actualValue)}.`,
      );
    }
  }
}

async function readExpectedFixtureSnapshot(options: {
  readonly fixture: DetectorFixtureCase;
  readonly invocationStartedAtMs: number;
  readonly repoRoot: string;
  readonly snapshotPath: string;
}): Promise<{
  readonly snapshot?: CheckIssueSnapshot;
  readonly snapshotPath: string;
}> {
  const expected = options.fixture.definition.expected;
  if (expected.snapshot?.expected === false) {
    if (await pathExists(options.snapshotPath)) {
      throw new Error(
        `Detector fixture ${options.fixture.id} produced an unexpected structured snapshot at ${options.snapshotPath}.`,
      );
    }
    return { snapshotPath: options.snapshotPath };
  }

  const structuredSnapshot = await readDetectorStructuredSnapshot({
    command: options.fixture.definition.command,
    fixtureId: options.fixture.id,
    invocationStartedAtMs: options.invocationStartedAtMs,
    repoRoot: options.repoRoot,
  });
  const snapshot = structuredSnapshot.snapshot;
  if (expected.snapshot?.complete === true && snapshot.status !== 'completed') {
    throw new Error(
      `Detector fixture ${options.fixture.id} expected a completed snapshot, received ${snapshot.status}.`,
    );
  }
  assertSnapshotOutcome({
    expectedExitCode: expected.exitCode,
    ...(expected.runOutcome === undefined
      ? {}
      : { expectedRunOutcome: expected.runOutcome }),
    fixtureId: options.fixture.id,
    kind: structuredSnapshot.kind,
    snapshot,
  });
  return {
    snapshot,
    snapshotPath: structuredSnapshot.snapshotPath,
  };
}

async function assertRequiredFixtureArtifacts(options: {
  readonly cli: RunLiminaResult | undefined;
  readonly fixture: DetectorFixtureCase;
  readonly snapshot: CheckIssueSnapshot | undefined;
  readonly snapshotPath: string;
}): Promise<void> {
  const expectsSnapshot =
    options.fixture.definition.expected.snapshot?.expected ?? true;
  if (
    !options.cli ||
    (expectsSnapshot &&
      (!options.snapshot || !(await pathExists(options.snapshotPath))))
  ) {
    throw new Error(
      `Detector fixture ${options.fixture.id} completed without its required CLI result or structured snapshot.`,
    );
  }
}

export async function runDetectorFixture(
  fixture: DetectorFixtureCase,
): Promise<DetectorFixtureRunResult> {
  assertExecutableDetectorFixtureKind(fixture);
  const isFaultInjection = fixture.definition.kind === 'fault-injection';
  const snapshotKind = getDetectorStructuredSnapshotKind(
    fixture.definition.command,
  );
  if (isFaultInjection && snapshotKind !== 'check-run') {
    throw new Error(
      `Detector fixture ${fixture.id} must use a formal snapshot-producing Limina check command.`,
    );
  }
  if ((fixture.definition.mutations?.length ?? 0) > 0) {
    throw new Error(
      `Detector fixture ${fixture.id} declares mutations, but multi-run mutation execution is not enabled in harness v2.`,
    );
  }

  const sourceBefore = await captureTreeSnapshot({
    rootDir: fixture.repoSourceRoot,
  });
  const sandbox = await createDetectorSandbox({ fixtureId: fixture.id });
  const configPath = path.join(sandbox.repoRoot, 'limina.config.mts');
  const harnessRoot = path.join(sandbox.sandboxRoot, 'harness');
  const faultPlanPath = path.join(harnessRoot, 'fault-plan.json');
  const receiptPath = path.join(harnessRoot, 'fault-receipt.json');
  const entry = isFaultInjection
    ? {
        args: ['--import', tsxLoaderPath, faultLauncherPath],
        executable: process.execPath,
      }
    : undefined;
  const invocationArgs = isFaultInjection
    ? [
        '--config',
        configPath,
        '--fault-plan',
        faultPlanPath,
        '--fixture-id',
        fixture.id,
        '--receipt',
        receiptPath,
        '--',
        ...fixture.definition.command,
      ]
    : ['--config', configPath, ...fixture.definition.command];
  let snapshotPath = getCheckIssueSnapshotPath(sandbox.repoRoot);
  let cli: RunLiminaResult | undefined;
  let registry: LocalRegistryFixture | undefined;
  let registryResult:
    | {
        readonly baseUrl: string;
        readonly requests: readonly RecordedRegistryRequest[];
      }
    | undefined;
  let snapshot: CheckIssueSnapshot | undefined;
  let sandboxBefore:
    | Awaited<ReturnType<typeof captureTreeSnapshot>>
    | undefined;
  let primaryError: unknown;
  const shouldMaterializeReleaseOutputs =
    fixture.id.startsWith('release/') &&
    fixture.definition.copyPolicy?.includeOutputDirectories === true;
  const copyPolicy = shouldMaterializeReleaseOutputs
    ? {
        ...fixture.definition.copyPolicy,
        includeOutputDirectories: false,
      }
    : fixture.definition.copyPolicy;

  try {
    await copyFixtureRepository({
      destinationRoot: sandbox.repoRoot,
      policy: copyPolicy,
      sourceRoot: fixture.repoSourceRoot,
    });
    if (shouldMaterializeReleaseOutputs) {
      await materializeReleaseFixtureOutputs({ repoRoot: sandbox.repoRoot });
    }
    await requireConfigFile(configPath, fixture.id);
    await applyFixtureSetup({
      fixtureId: fixture.id,
      operations: fixture.definition.setup ?? [],
      sandboxRoot: sandbox.sandboxRoot,
    });
    if (isFaultInjection) {
      await mkdir(harnessRoot, { recursive: true });
      await writeFile(
        faultPlanPath,
        `${JSON.stringify(
          {
            fault: fixture.definition.fault,
            secondaryFault: fixture.definition.secondaryFault,
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
    }
    const toolBridges = await createFixtureToolBridges({
      fixtureId: fixture.id,
      repoRoot: sandbox.repoRoot,
      tools: fixture.definition.tools ?? [],
    });
    let environment = await createDetectorInvocationEnvironment({
      fixtureEnvironment: fixture.definition.environment,
      sandboxRoot: sandbox.sandboxRoot,
      toolBinDirectory: toolBridges.binDirectory,
    });
    if (fixture.definition.registry) {
      registry = await startLocalRegistryFixture({
        scenario: fixture.definition.registry,
        tempRoot: path.join(sandbox.sandboxRoot, 'tmp'),
      });
      environment = {
        ...environment,
        [INTERNAL_RELEASE_REGISTRY_URL_ENV]: registry.baseUrl.toString(),
        ...(fixture.definition.registry.requestTimeoutMs === undefined
          ? {}
          : {
              [INTERNAL_RELEASE_REGISTRY_TIMEOUT_ENV]: String(
                fixture.definition.registry.requestTimeoutMs,
              ),
            }),
      };
    }
    sandboxBefore = await captureTreeSnapshot({
      ignoredPathPrefixes: DEFAULT_SANDBOX_IGNORED_PATH_PREFIXES,
      rootDir: sandbox.sandboxRoot,
    });
    await assertNoPreexistingDetectorSnapshots(sandbox.repoRoot);
    const invocationStartedAtMs = Date.now();

    try {
      cli = await runLimina({
        args: invocationArgs,
        cwd: sandbox.repoRoot,
        entry,
        env: environment,
        fixtureName: fixture.id,
        inheritParentEnv: false,
        timeout: 90_000,
      });
      assertCliResult({
        expectedExitCode: fixture.definition.expected.exitCode,
        fixtureId: fixture.id,
        result: cli,
      });
      const receipt = isFaultInjection
        ? await readFaultReceipt({ fixtureId: fixture.id, receiptPath })
        : undefined;
      if (receipt) {
        assertFaultReceiptExpectation({ fixture, receipt });
      }
      const snapshotResult = await readExpectedFixtureSnapshot({
        fixture,
        invocationStartedAtMs,
        repoRoot: sandbox.repoRoot,
        snapshotPath,
      });
      snapshot = snapshotResult.snapshot;
      snapshotPath = snapshotResult.snapshotPath;
      assertExpectedRunState({
        fixture,
        run: snapshot?.run ?? receipt?.run,
      });
      assertDetectorIssues({
        actualIssues: snapshot?.issues ?? receipt?.execution?.issues ?? [],
        expected: fixture.definition.expected,
        fixtureId: fixture.id,
        repoRoot: sandbox.repoRoot,
      });
      assertLinesInOrder({
        fixtureId: fixture.id,
        label: 'stdout',
        lines: fixture.definition.expected.stdout?.linesInOrder,
        output: cli.stdout,
      });
      assertLinesInOrder({
        fixtureId: fixture.id,
        label: 'stderr',
        lines: fixture.definition.expected.stderr?.linesInOrder,
        output: cli.stderr,
      });
    } catch (error) {
      primaryError = error;
    }

    try {
      if (registry && fixture.definition.registry) {
        const requests = registry.requests;
        assertLocalRegistryRequests({
          actual: requests,
          expected: fixture.definition.registry.expectedRequests,
          fixtureId: fixture.id,
        });
        registryResult = {
          baseUrl: registry.baseUrl.toString(),
          requests,
        };
      }
    } catch (error) {
      primaryError =
        primaryError === undefined ? error : combineErrors(primaryError, error);
    }

    try {
      if (sandboxBefore) {
        const sandboxAfter = await captureTreeSnapshot({
          ignoredPathPrefixes: DEFAULT_SANDBOX_IGNORED_PATH_PREFIXES,
          rootDir: sandbox.sandboxRoot,
        });
        assertTreeSnapshotUnchanged({
          after: sandboxAfter,
          allowedAddedPaths: fixture.definition.allowedGeneratedPaths,
          before: sandboxBefore,
          label: `Detector fixture ${fixture.id} sandbox inputs`,
        });
      }
      const sourceAfter = await captureTreeSnapshot({
        rootDir: fixture.repoSourceRoot,
      });
      assertTreeSnapshotUnchanged({
        after: sourceAfter,
        before: sourceBefore,
        label: `Detector fixture ${fixture.id} source repo`,
      });
    } catch (error) {
      primaryError =
        primaryError === undefined ? error : combineErrors(primaryError, error);
    }

    if (primaryError !== undefined) {
      throw primaryError;
    }
    await assertRequiredFixtureArtifacts({
      cli,
      fixture,
      snapshot,
      snapshotPath,
    });
  } catch (error) {
    primaryError = contextualizeFailure({
      casePath: fixture.casePath,
      cli,
      error,
      entry,
      fixtureId: fixture.id,
      invocationArgs,
      repoRoot: sandbox.repoRoot,
      sandboxRoot: sandbox.sandboxRoot,
      snapshotPath,
    });
  }

  const preserved = process.env[PRESERVE_INTEGRATION_ARTIFACTS_ENV] === '1';
  let cleaned = false;
  await finishFixtureCleanup({
    cleanup: async () => {
      let cleanupError: unknown;
      try {
        await registry?.close();
      } catch (error) {
        cleanupError = error;
      }
      try {
        cleaned = await cleanupDetectorSandbox({
          preserve: preserved,
          sandboxRoot: sandbox.sandboxRoot,
          tempRoot: sandbox.tempRoot,
        });
      } catch (error) {
        cleanupError =
          cleanupError === undefined
            ? error
            : combineErrors(cleanupError, error);
      }
      if (cleanupError !== undefined) {
        throw cleanupError;
      }
      if (preserved) {
        console.info(
          `Detector fixture ${fixture.id} artifact preserved at ${sandbox.sandboxRoot}`,
        );
      }
    },
    primaryError,
  });

  return {
    cleaned,
    cli: cli!,
    fixtureId: fixture.id,
    preserved,
    registry: registryResult,
    sandboxRoot: sandbox.sandboxRoot,
    ...(snapshot ? { snapshot } : {}),
    snapshotPath,
  };
}
