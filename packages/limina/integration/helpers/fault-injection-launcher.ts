import type {
  BuiltinTaskName,
  PipelineStep,
  ResolvedLiminaConfig,
} from '#config/runner';
import { loadConfig } from '#config/runner';
import { type AnalysisProviderSet, createAnalysisProviders } from '#core';
import { collectRawWorkspacePackages } from '#core/workspace/actions';
import { spawn, type SpawnOptions } from 'node:child_process';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AtomicWriteOptions } from '../../src/check-reporting/atomic-writer';
import {
  type CheckRunRecorder,
  createCheckRunRecorder,
} from '../../src/check-reporting/run-recorder';
import {
  type LiminaCheckRunSummary,
  writeCheckIssueSnapshotOnly,
  writeSourceIssueSnapshotOnly,
} from '../../src/check-reporting/snapshot';
import { runCheckWithCliFlowCleanup } from '../../src/cli';
import type {
  RunExecutionPlanOptions,
  RunExecutionResult,
} from '../../src/execution/executor';
import type { ExecutionPlan } from '../../src/execution/tasks';
import { LiminaFlowReporter } from '../../src/flow';
import {
  type CommandProcessDependencies,
  createExecutionPlan,
  runPipelineWithResult,
} from '../../src/pipeline/runner';
import { LiminaPreflightManager } from '../../src/preflight';
import { runCheckerHostProtocolProbeForTesting } from '../../src/typecheck/process-host';
import { createVueTsgoCachePaths } from '../../src/typecheck/targets';
import type { VueTsgoCacheCleanupDependencies } from '../../src/typecheck/vue-tsgo-cache';
import type { FaultInjectionDefinition } from './detector-fixture-types';
import {
  createInjectedFaultError,
  FaultInjectionController,
  validateFaultInjectionDefinition,
} from './fault-injection';

interface LauncherArguments {
  readonly command: readonly string[];
  readonly configPath: string;
  readonly faultPlanPath: string;
  readonly fixtureId: string;
  readonly receiptPath: string;
}

interface SerializedError {
  readonly code?: string;
  readonly message: string;
  readonly name: string;
}

interface FaultPlanDocument {
  readonly fault: unknown;
  readonly secondaryFault?: unknown;
}

interface BoundaryReceipt {
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
}

type MutableBoundaryReceipt = {
  -readonly [Key in keyof BoundaryReceipt]: BoundaryReceipt[Key];
};

const SNAPSHOT_FAULT_POINTS = new Set([
  'filesystem.close',
  'filesystem.fsync',
  'filesystem.rename',
  'filesystem.write',
  'snapshot.install',
  'snapshot.serialize',
  'snapshot.write',
]);

function faultDefinitions(
  primary: FaultInjectionDefinition,
  secondary?: FaultInjectionDefinition,
): readonly FaultInjectionDefinition[] {
  return secondary ? [primary, secondary] : [primary];
}

function injectMatchingThrow(
  controller: FaultInjectionController,
  definitions: readonly FaultInjectionDefinition[],
  point: FaultInjectionDefinition['point'],
): void {
  for (const definition of definitions) {
    if (definition.point === point) {
      controller.throwIfRequested(point, definition.task);
    }
  }
}

function parseArguments(argv: readonly string[]): LauncherArguments {
  const values = new Map<string, string>();
  let commandStart = -1;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      commandStart = index + 1;
      break;
    }
    if (!argument?.startsWith('--')) {
      throw new Error(`Unexpected launcher argument: ${String(argument)}.`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Launcher argument ${argument} requires a value.`);
    }
    values.set(argument, value);
    index += 1;
  }

  const requireValue = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`Missing launcher argument ${name}.`);
    return value;
  };
  const command = commandStart < 0 ? [] : argv.slice(commandStart);
  if (command[0] !== 'check') {
    throw new Error(
      'Fault launcher requires a snapshot-producing check command.',
    );
  }

  return {
    command,
    configPath: requireValue('--config'),
    faultPlanPath: requireValue('--fault-plan'),
    fixtureId: requireValue('--fixture-id'),
    receiptPath: requireValue('--receipt'),
  };
}

function serializeError(error: unknown): SerializedError {
  const normalized = error instanceof Error ? error : new Error(String(error));
  return {
    ...('code' in normalized ? { code: String(normalized.code) } : {}),
    message: normalized.message,
    name: normalized.name,
  };
}

function getHelperPath(): string {
  return fileURLToPath(new URL('fault-process-helper.mjs', import.meta.url));
}

function createHelperCommand(mode: string, value?: string): PipelineStep {
  return {
    args: [getHelperPath(), mode, ...(value === undefined ? [] : [value])],
    command: process.execPath,
    type: 'command',
  };
}

function createVueTsgoCleanupCommand(): PipelineStep {
  return {
    args: ['--project', 'tsconfig.json'],
    command: 'vue-tsgo',
    type: 'command',
  };
}

function injectProtocolFault(options: {
  readonly boundaryErrors: Error[];
  readonly config: ResolvedLiminaConfig;
  readonly controller: FaultInjectionController;
  readonly definition: FaultInjectionDefinition;
  readonly plan: ExecutionPlan;
}): void {
  if (options.definition.point !== 'process.protocol') return;
  const fault = options.definition.fault;
  if (fault.kind !== 'invalid-protocol') {
    throw new Error('Protocol injection requires an invalid-protocol fault.');
  }
  const matchingTasks = options.plan.tasks.filter(
    (task) => task.issueTask === options.definition.task,
  );
  if (matchingTasks.length !== 1) {
    throw new Error(
      `Expected one ${options.definition.task} protocol task, found ${matchingTasks.length}.`,
    );
  }
  const task = matchingTasks[0]!;
  task.run = async () => {
    let degraded = false;
    const measurement = await runCheckerHostProtocolProbeForTesting({
      entry: {
        args: [getHelperPath(), 'ipc-invalid', fault.payload],
        command: process.execPath,
      },
      onDegraded: () => {
        degraded = true;
      },
      onProtocolMessage: (message) => {
        if (message !== fault.payload) return;
        const observed = options.controller.observe(
          'process.protocol',
          options.definition.task,
        );
        if (observed?.kind !== 'invalid-protocol') {
          options.boundaryErrors.push(
            new Error('Checker host protocol fault was not consumed.'),
          );
        }
      },
      spec: {
        args: [getHelperPath(), 'success'],
        command: process.execPath,
        cwd: options.config.rootDir,
        env: process.env,
        shell: false,
        stdio: 'inherit',
      },
    });
    if (!degraded) {
      options.boundaryErrors.push(
        new Error('Invalid checker host protocol did not trigger degradation.'),
      );
    }
    if (measurement.error) throw measurement.error;
    if (measurement.status !== 0) {
      throw new Error(
        `Checker host protocol retry exited with code ${measurement.status}.`,
      );
    }
    return { issues: [], status: 'passed' };
  };
}

function selectPipelineStep(
  definition: FaultInjectionDefinition,
): PipelineStep {
  switch (definition.task) {
    case 'checker:build':
    case 'checker:typecheck':
    case 'graph:check':
    case 'graph:prepare':
    case 'package:check':
    case 'proof:check':
    case 'release:check':
    case 'source:check': {
      return definition.task satisfies BuiltinTaskName;
    }
    case 'graph:materialize': {
      return 'checker:build';
    }
    case 'workspace:validate': {
      return 'graph:check';
    }
    case 'command': {
      const fault = definition.fault;
      if (
        definition.point === 'cleanup.execute' ||
        definition.point === 'execution.finalize'
      ) {
        return createVueTsgoCleanupCommand();
      }
      if (definition.point === 'process.wait') {
        if (fault.kind === 'process-exit') {
          return createHelperCommand('exit', String(fault.exitCode));
        }
        if (fault.kind === 'process-signal') {
          return createHelperCommand('timeout');
        }
        if (fault.kind === 'timeout') {
          return createHelperCommand('timeout');
        }
      }
      if (definition.point === 'process.protocol') {
        if (fault.kind !== 'invalid-protocol') {
          throw new Error('Invalid protocol point requires invalid-protocol.');
        }
        return createHelperCommand('invalid-protocol', fault.payload);
      }
      if (
        definition.point === 'process.stdout' ||
        definition.point === 'process.stderr'
      ) {
        return createHelperCommand('streams');
      }
      return createHelperCommand('success');
    }
  }

  throw new Error(`Unsupported fault task: ${definition.task}.`);
}

function createFaultConfig(
  config: ResolvedLiminaConfig,
  definition: FaultInjectionDefinition,
): ResolvedLiminaConfig {
  return {
    ...config,
    pipelines: {
      ...config.pipelines,
      'fault-injection': [selectPipelineStep(definition)],
    },
  };
}

function injectExecutionBoundaryFault(
  plan: ExecutionPlan,
  controller: FaultInjectionController,
  definition: FaultInjectionDefinition,
): void {
  if (definition.point !== 'task.execute') {
    return;
  }
  const matchingTasks = plan.tasks.filter(
    (task) => task.issueTask === definition.task,
  );
  if (matchingTasks.length !== 1) {
    throw new Error(
      `Expected one ${definition.task} execution task, found ${matchingTasks.length}.`,
    );
  }
  const task = matchingTasks[0]!;
  const run = task.run;
  task.run = async (context) => {
    controller.throwIfRequested(definition.point, task.issueTask);
    return run(context);
  };
}

function createFilesystemReadProviders(options: {
  readonly config: ResolvedLiminaConfig;
  readonly controller: FaultInjectionController;
  readonly definitions: readonly FaultInjectionDefinition[];
}): AnalysisProviderSet | undefined {
  const definition = options.definitions.find(
    (candidate) => candidate.point === 'filesystem.read',
  );
  if (!definition) return undefined;

  return createAnalysisProviders(options.config, undefined, undefined, {
    workspace: {
      collectRawWorkspacePackages: async (config) => {
        options.controller.throwIfRequested('filesystem.read', definition.task);
        return collectRawWorkspacePackages(config);
      },
    },
  });
}

function usesVueTsgoCleanupCommand(
  definitions: readonly FaultInjectionDefinition[],
): boolean {
  return definitions.some(
    (definition) =>
      definition.task === 'command' &&
      (definition.point === 'cleanup.execute' ||
        definition.point === 'execution.finalize'),
  );
}

async function createVueTsgoCleanupDependencies(options: {
  readonly boundary: MutableBoundaryReceipt;
  readonly config: ResolvedLiminaConfig;
  readonly controller: FaultInjectionController;
  readonly definitions: readonly FaultInjectionDefinition[];
}): Promise<VueTsgoCacheCleanupDependencies | undefined> {
  if (!usesVueTsgoCleanupCommand(options.definitions)) return undefined;

  const configPath = path.join(options.config.rootDir, 'tsconfig.json');
  const expectedResourcePaths = new Set(createVueTsgoCachePaths(configPath));
  if (expectedResourcePaths.size !== 1) {
    throw new Error(
      `Expected one vue-tsgo cache cleanup resource, received ${expectedResourcePaths.size}.`,
    );
  }
  for (const resourcePath of expectedResourcePaths) {
    await mkdir(resourcePath, { recursive: true });
    await writeFile(
      path.join(resourcePath, 'stale.txt'),
      'controlled stale vue-tsgo cache bytes\n',
      'utf8',
    );
  }

  const observedGenerations = new Set<string>();
  return {
    afterDirectoryCleanup() {
      options.boundary.cleanupResourcesRemoved += 1;
      for (const definition of options.definitions) {
        if (
          definition.point !== 'cleanup.execute' ||
          definition.task !== 'command'
        ) {
          continue;
        }
        options.controller.throwIfRequested('cleanup.execute', definition.task);
      }
    },
    observeDescriptor(descriptor) {
      if (
        !expectedResourcePaths.has(descriptor.path) ||
        descriptor.authority.logicalMutationRoot !== descriptor.path ||
        descriptor.authority.scope !== 'directory' ||
        descriptor.kind !== 'directory' ||
        descriptor.recursive !== true
      ) {
        throw new Error(
          `Unexpected vue-tsgo cleanup descriptor: ${JSON.stringify({
            kind: descriptor.kind,
            path: descriptor.path,
            recursive: descriptor.recursive,
            scope: descriptor.authority.scope,
          })}.`,
        );
      }
      options.boundary.cleanupDescriptorCount += 1;
      options.boundary.cleanupDirectoryDescriptorCount += 1;
      observedGenerations.add(descriptor.authority.generation);
      options.boundary.cleanupGenerationCount = observedGenerations.size;
    },
  };
}

function createFaultProcessDependencies(options: {
  readonly boundaryErrors: Error[];
  readonly controller: FaultInjectionController;
  readonly definitions: readonly FaultInjectionDefinition[];
}): CommandProcessDependencies | undefined {
  const processFaults = options.definitions.filter((definition) =>
    definition.point.startsWith('process.'),
  );
  const usesCleanupCommand = usesVueTsgoCleanupCommand(options.definitions);
  if (processFaults.length === 0 && !usesCleanupCommand) return undefined;

  const timeoutFault = processFaults.find(
    (definition) =>
      definition.point === 'process.wait' &&
      definition.fault.kind === 'timeout',
  );

  return {
    spawn(command, args, spawnOptions: SpawnOptions) {
      if (
        usesCleanupCommand &&
        ['vue-tsgo', 'vue-tsgo.cmd'].includes(
          path.basename(command).toLowerCase(),
        )
      ) {
        return spawn(process.execPath, [getHelperPath(), 'success'], {
          ...spawnOptions,
          shell: false,
        });
      }
      injectMatchingThrow(options.controller, processFaults, 'process.spawn');

      for (const definition of processFaults) {
        if (
          definition.point === 'process.wait' &&
          definition.fault.kind === 'timeout'
        ) {
          options.controller.observe('process.wait', definition.task);
        }
      }

      const child = spawn(command, [...args], spawnOptions);

      for (const definition of processFaults) {
        if (
          definition.point !== 'process.wait' ||
          definition.fault.kind !== 'process-signal'
        ) {
          continue;
        }
        const { signal } = definition.fault;
        child.once('spawn', () => {
          child.kill(signal);
        });
      }

      child.on('close', (code, signal) => {
        for (const definition of processFaults) {
          if (
            definition.point !== 'process.wait' ||
            definition.fault.kind === 'timeout'
          ) {
            continue;
          }
          const fault = options.controller.observe(
            'process.wait',
            definition.task,
          );
          if (!fault) continue;
          if (
            fault.kind === 'process-exit' &&
            (code !== fault.exitCode || signal !== null)
          ) {
            options.boundaryErrors.push(
              new Error(
                `Controlled process exited with code ${String(code)} and signal ${String(signal)}, expected code ${fault.exitCode}.`,
              ),
            );
          }
          if (fault.kind === 'process-signal' && signal !== fault.signal) {
            options.boundaryErrors.push(
              new Error(
                `Controlled process exited with code ${String(code)} and signal ${String(signal)}, expected signal ${fault.signal}.`,
              ),
            );
          }
        }
      });

      for (const definition of processFaults) {
        if (
          definition.point !== 'process.stdout' &&
          definition.point !== 'process.stderr'
        ) {
          continue;
        }
        const stream =
          definition.point === 'process.stdout' ? child.stdout : child.stderr;
        stream?.on('data', () => {
          const fault = options.controller.observe(
            definition.point,
            definition.task,
          );
          if (!fault) return;
          if (fault.kind !== 'stream-error') {
            options.boundaryErrors.push(
              new Error(
                `Unexpected ${fault.kind} fault at ${definition.point}.`,
              ),
            );
            return;
          }
          queueMicrotask(() => {
            stream.emit('error', createInjectedFaultError(fault));
          });
        });
      }

      return child;
    },
    ...(timeoutFault ? { timeoutMs: 150 } : {}),
  };
}

function createSnapshotWriteOptions(options: {
  readonly boundary: {
    tempCleanupAttempts: number;
    tempCleanupCompleted: boolean;
    removedTempFiles: number;
  };
  readonly controller: FaultInjectionController;
  readonly definitions: readonly FaultInjectionDefinition[];
}): AtomicWriteOptions {
  return {
    openTemp: async (tempPath, flags) => {
      const handle = await open(tempPath, flags);
      return {
        close: async () => {
          await handle.close();
          injectMatchingThrow(
            options.controller,
            options.definitions,
            'filesystem.close',
          );
        },
        sync: async () => {
          injectMatchingThrow(
            options.controller,
            options.definitions,
            'filesystem.fsync',
          );
          await handle.sync();
        },
        writeFile: async (data, encoding) => {
          injectMatchingThrow(
            options.controller,
            options.definitions,
            'snapshot.write',
          );
          injectMatchingThrow(
            options.controller,
            options.definitions,
            'filesystem.write',
          );
          await handle.writeFile(data, encoding);
        },
      };
    },
    removeTemp: async (tempPath) => {
      options.boundary.tempCleanupAttempts += 1;
      await rm(tempPath, { force: true });
      options.boundary.tempCleanupCompleted = true;
      options.boundary.removedTempFiles += 1;
    },
    rename: async (from, to) => {
      injectMatchingThrow(
        options.controller,
        options.definitions,
        'snapshot.install',
      );
      injectMatchingThrow(
        options.controller,
        options.definitions,
        'filesystem.rename',
      );
      await rename(from, to);
    },
    retryDelaysMs: [],
    serialize: (value) => {
      injectMatchingThrow(
        options.controller,
        options.definitions,
        'snapshot.serialize',
      );
      return JSON.stringify(value, null, 2);
    },
  };
}

function createSnapshotWriters(options: {
  readonly boundary: {
    tempCleanupAttempts: number;
    tempCleanupCompleted: boolean;
    removedTempFiles: number;
  };
  readonly controller: FaultInjectionController;
  readonly definitions: readonly FaultInjectionDefinition[];
}): RunExecutionPlanOptions['snapshotWriters'] | undefined {
  if (
    !options.definitions.some((definition) =>
      SNAPSHOT_FAULT_POINTS.has(definition.point),
    )
  ) {
    return undefined;
  }
  const atomicWriteOptions = createSnapshotWriteOptions(options);
  return {
    writeCheck: async (namespace, snapshot) =>
      writeCheckIssueSnapshotOnly(namespace, snapshot, atomicWriteOptions),
    writeSource: writeSourceIssueSnapshotOnly,
  };
}

function createFinalizationRecorder(
  recorder: CheckRunRecorder,
  controller: FaultInjectionController,
  definitions: readonly FaultInjectionDefinition[],
): CheckRunRecorder {
  if (
    !definitions.some((definition) => definition.point === 'execution.finalize')
  ) {
    return recorder;
  }

  return {
    ...recorder,
    finish(outcome, completedAt) {
      recorder.finish(outcome, completedAt);
      injectMatchingThrow(controller, definitions, 'execution.finalize');
    },
  };
}

function commandText(command: readonly string[]): string {
  return `limina ${command.join(' ')}`;
}

async function readFaultPlan(path: string): Promise<{
  readonly fault: FaultInjectionDefinition;
  readonly secondaryFault?: FaultInjectionDefinition;
}> {
  const document = JSON.parse(
    await readFile(path, 'utf8'),
  ) as FaultPlanDocument;
  return {
    fault: validateFaultInjectionDefinition(document.fault, 'fault plan'),
    secondaryFault:
      document.secondaryFault === undefined
        ? undefined
        : validateFaultInjectionDefinition(
            document.secondaryFault,
            'secondary fault plan',
          ),
  };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const boundary: MutableBoundaryReceipt = {
    cleanupDescriptorCount: 0,
    cleanupDirectoryDescriptorCount: 0,
    cleanupFileDescriptorCount: 0,
    cleanupGenerationCount: 0,
    cleanupResourcesRemoved: 0,
    flowCleanupAttempts: 0,
    flowCleanupCompleted: false,
    flowResourcesClosed: false,
    removedTempFiles: 0,
    tempCleanupAttempts: 0,
    tempCleanupCompleted: false,
  };
  const boundaryErrors: Error[] = [];
  let caughtError: unknown;
  let execution: RunExecutionResult | undefined;
  let run: LiminaCheckRunSummary | undefined;
  let controller: FaultInjectionController | undefined;
  let baseRecorder: CheckRunRecorder | undefined;

  try {
    const planDocument = await readFaultPlan(args.faultPlanPath);
    const definitions = faultDefinitions(
      planDocument.fault,
      planDocument.secondaryFault,
    );
    controller = new FaultInjectionController(
      planDocument.fault,
      planDocument.secondaryFault,
    );
    const loadedConfig = await loadConfig({
      command: 'check',
      configLoader: 'tsx',
      configPath: args.configPath,
      cwd: process.cwd(),
    });
    const config = createFaultConfig(loadedConfig, planDocument.fault);
    const providers = createFilesystemReadProviders({
      config,
      controller,
      definitions,
    });
    const preflight = new LiminaPreflightManager({
      config,
      ...(providers ? { providers } : {}),
    });
    const vueTsgoCacheCleanup = await createVueTsgoCleanupDependencies({
      boundary,
      config,
      controller,
      definitions,
    });
    const commandProcess = createFaultProcessDependencies({
      boundaryErrors,
      controller,
      definitions,
    });
    const plan = createExecutionPlan(config, 'fault-injection', {
      ...(commandProcess ? { commandProcess } : {}),
      preflight,
      ...(vueTsgoCacheCleanup ? { vueTsgoCacheCleanup } : {}),
    });
    injectExecutionBoundaryFault(plan, controller, planDocument.fault);
    injectProtocolFault({
      boundaryErrors,
      config,
      controller,
      definition: planDocument.fault,
      plan,
    });
    if (planDocument.secondaryFault) {
      injectExecutionBoundaryFault(
        plan,
        controller,
        planDocument.secondaryFault,
      );
      injectProtocolFault({
        boundaryErrors,
        config,
        controller,
        definition: planDocument.secondaryFault,
        plan,
      });
    }
    baseRecorder = createCheckRunRecorder({
      command: commandText(args.command),
      configPath: config.configPath,
      pipeline: 'fault-injection',
      plannedTasks: plan.tasks,
      rootDir: config.rootDir,
    });
    const recorder = createFinalizationRecorder(
      baseRecorder,
      controller,
      definitions,
    );
    const snapshotWriters = createSnapshotWriters({
      boundary,
      controller,
      definitions,
    });
    const flow = new LiminaFlowReporter({
      forceTty:
        usesVueTsgoCleanupCommand(definitions) ||
        definitions.some((definition) =>
          definition.point.startsWith('process.'),
        ),
      renderer: 'inline',
    });

    await runCheckWithCliFlowCleanup(
      {
        close: async () => {
          boundary.flowCleanupAttempts += 1;
          await flow.close();
          boundary.flowResourcesClosed = true;
          injectMatchingThrow(controller!, definitions, 'cleanup.execute');
          boundary.flowCleanupCompleted = true;
        },
        outro: (message) => flow.outro(message),
      },
      async () => {
        execution = await runPipelineWithResult(config, 'fault-injection', {
          checkIssueReport: {
            command: commandText(args.command),
            defer: true,
          },
          checkRunRecorder: recorder,
          ...(commandProcess ? { commandProcess } : {}),
          executionPlan: plan,
          flow,
          preflight,
          ...(snapshotWriters ? { snapshotWriters } : {}),
          ...(vueTsgoCacheCleanup ? { vueTsgoCacheCleanup } : {}),
        });
        return execution.passed;
      },
    );

    if (boundaryErrors.length > 0) {
      throw boundaryErrors[0];
    }
  } catch (error) {
    caughtError = error;
  } finally {
    run = baseRecorder?.getRunSummary();
  }

  try {
    controller?.assertConsumed(args.fixtureId);
  } catch (error) {
    caughtError ??= error;
  }

  await writeFile(
    args.receiptPath,
    `${JSON.stringify(
      {
        error:
          caughtError === undefined ? undefined : serializeError(caughtError),
        boundary: boundary satisfies BoundaryReceipt,
        execution,
        fixtureId: args.fixtureId,
        observations: controller?.observations() ?? [],
        run,
        version: 1,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  if (caughtError !== undefined || execution?.passed !== true) {
    process.exitCode = 1;
  }
}

await main();
