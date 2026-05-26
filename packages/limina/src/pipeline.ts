import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { getCheckerAdapter } from './checkers';
import { runGraphCheck } from './commands/graph';
import { runPackageCheck } from './commands/package';
import { runProofCheck } from './commands/proof';
import { runReleaseCheck } from './commands/release';
import { runSourceCheck } from './commands/source';
import { runCheckerBuild, runCheckerTypecheck } from './commands/typecheck';
import type {
  BuiltinTaskName,
  PipelineStep,
  ResolvedLiminaConfig,
} from './config';
import { getActiveCheckers } from './config';
import type { LiminaFlowReporter } from './flow';

interface RunPipelineOptions {
  cwd?: string;
  flow?: LiminaFlowReporter;
  packageNames?: readonly string[];
}

type NormalizedPipelineStep = Exclude<PipelineStep, string>;

const builtInTaskNames = new Set<string>([
  'checker:build',
  'checker:typecheck',
  'graph:check',
  'package:check',
  'proof:check',
  'release:check',
  'source:check',
]);

const defaultCheckPipeline: PipelineStep[] = [
  'graph:check',
  'source:check',
  'proof:check',
  'checker:build',
  'checker:typecheck',
];

function reportCheckerCapabilities(
  config: ResolvedLiminaConfig,
  flow: LiminaFlowReporter | undefined,
): void {
  if (!flow) {
    return;
  }

  const firstClass: string[] = [];
  const sourceOnly: string[] = [];

  for (const checker of getActiveCheckers(config)) {
    const adapter = getCheckerAdapter(checker.preset);
    const label = `${checker.name} (${checker.preset})`;

    if (adapter?.tier === 'first-class') {
      firstClass.push(label);
    } else if (adapter?.tier === 'source-only') {
      sourceOnly.push(label);
    }
  }

  flow.info(
    [
      'checker capability summary:',
      `  first-class: ${firstClass.length > 0 ? firstClass.join(', ') : '(none)'}`,
      `  source-only: ${sourceOnly.length > 0 ? sourceOnly.join(', ') : '(none)'}`,
      ...(sourceOnly.length > 0
        ? [
            '  note: source-only checkers get coverage proof and direct typecheck, but Limina does not parse their internal import graph.',
          ]
        : []),
    ].join('\n'),
    { depth: 1 },
  );
}

function isBuiltinTaskName(value: string): value is BuiltinTaskName {
  return builtInTaskNames.has(value);
}

export function getPipelineStepLabel(step: NormalizedPipelineStep): string {
  if (step.type === 'task') {
    return step.name;
  }

  return [step.command, ...(step.args ?? [])].join(' ');
}

export async function runBuiltinTask(
  config: ResolvedLiminaConfig,
  taskName: BuiltinTaskName,
  options: RunPipelineOptions = {},
): Promise<boolean> {
  switch (taskName) {
    case 'graph:check': {
      return runGraphCheck(config, {
        clearScreen: false,
        flow: options.flow,
        flowDepth: 1,
      });
    }
    case 'proof:check': {
      return runProofCheck(config, {
        clearScreen: false,
        flow: options.flow,
        flowDepth: 1,
      });
    }
    case 'source:check': {
      return runSourceCheck(config, {
        clearScreen: false,
        flow: options.flow,
        flowDepth: 1,
      });
    }
    case 'package:check': {
      return runPackageCheck({
        clearScreen: false,
        config,
        cwd: options.cwd,
        flow: options.flow,
        flowDepth: 1,
        packageNames: options.packageNames,
      });
    }
    case 'release:check': {
      return runReleaseCheck({
        clearScreen: false,
        config,
        cwd: options.cwd,
        flow: options.flow,
        flowDepth: 1,
        packageNames: options.packageNames,
      });
    }
    case 'checker:typecheck': {
      const result = await runCheckerTypecheck({
        clearScreen: false,
        config,
        cwd: config.rootDir,
        flow: options.flow,
        flowDepth: 1,
      });

      return result.passed;
    }
    case 'checker:build': {
      const result = await runCheckerBuild({
        clearScreen: false,
        config,
        cwd: config.rootDir,
        flow: options.flow,
        flowDepth: 1,
      });

      return result.passed;
    }
  }
}

export function normalizePipelineStep(
  step: PipelineStep,
): NormalizedPipelineStep {
  if (typeof step !== 'string') {
    return step;
  }

  if (isBuiltinTaskName(step)) {
    return {
      name: step,
      type: 'task',
    };
  }

  const [command, ...args] = step.split(/\s+/u).filter(Boolean);

  if (!command) {
    throw new Error('Pipeline command step must not be empty.');
  }

  return {
    args,
    command,
    type: 'command',
  };
}

export function runCommandStep(
  config: ResolvedLiminaConfig,
  step: Extract<PipelineStep, { type: 'command' }>,
  options: RunPipelineOptions = {},
): Promise<boolean> | boolean {
  const label = getPipelineStepLabel(step);
  const task = options.flow?.start(`command: ${label}`, { depth: 1 });
  const commandOptions = {
    cwd: step.cwd ? path.resolve(config.rootDir, step.cwd) : config.rootDir,
    env: {
      ...process.env,
      ...step.env,
    },
    shell: process.platform === 'win32',
  };

  if (options.flow?.interactive) {
    return new Promise((resolve, reject) => {
      const child = spawn(step.command, step.args ?? [], {
        ...commandOptions,
        stdio: ['inherit', 'pipe', 'pipe'],
      });

      child.stdout?.on('data', (chunk: Uint8Array) => {
        options.flow?.writeOutput(chunk, { stream: 'stdout' });
      });
      child.stderr?.on('data', (chunk: Uint8Array) => {
        options.flow?.writeOutput(chunk, { stream: 'stderr' });
      });

      child.on('error', (error) => {
        task?.fail(undefined, { error });
        reject(error);
      });
      child.on('close', (code) => {
        const passed = (code ?? 1) === 0;

        if (passed) {
          task?.pass();
        } else {
          task?.fail(`command failed: ${label} exited with code ${code ?? 1}`);
        }

        resolve(passed);
      });
    });
  }

  const result = spawnSync(step.command, step.args ?? [], {
    ...commandOptions,
    stdio: 'inherit',
  });

  if (result.error) {
    task?.fail(undefined, { error: result.error });
    throw result.error;
  }

  const passed = (result.status ?? 1) === 0;

  if (passed) {
    task?.pass();
  } else {
    task?.fail(
      `command failed: ${label} exited with code ${result.status ?? 1}`,
    );
  }

  return passed;
}

export async function runPipeline(
  config: ResolvedLiminaConfig,
  pipelineName: string,
  options: RunPipelineOptions = {},
): Promise<boolean> {
  const steps = config.pipelines?.[pipelineName];

  if (!steps) {
    throw new Error(
      [
        `Pipeline instruction "${pipelineName}" was not found.`,
        `Define it in ${path.relative(config.rootDir, config.configPath)} under the "pipelines" field, then run "limina check ${pipelineName}" again.`,
      ].join('\n'),
    );
  }

  const normalizedSteps = steps.map(normalizePipelineStep);
  const pipelineTask = options.flow?.start(`pipeline: ${pipelineName}`, {
    collapseOnSuccess: false,
  });

  for (const [stepIndex, step] of normalizedSteps.entries()) {
    const passed =
      step.type === 'task'
        ? await runBuiltinTask(config, step.name, options)
        : await runCommandStep(config, step, options);

    if (!passed) {
      const label = getPipelineStepLabel(step);

      pipelineTask?.fail(`pipeline blocked: ${pipelineName} at ${label}`);

      for (const remainingStep of normalizedSteps.slice(stepIndex + 1)) {
        options.flow?.skip(`skipped: ${getPipelineStepLabel(remainingStep)}`, {
          depth: 1,
        });
      }

      return false;
    }
  }

  pipelineTask?.pass();

  return true;
}

export async function runDefaultCheck(
  config: ResolvedLiminaConfig,
  options: RunPipelineOptions = {},
): Promise<boolean> {
  const normalizedSteps = defaultCheckPipeline.map(normalizePipelineStep);
  const pipelineTask = options.flow?.start('default check', {
    collapseOnSuccess: false,
  });

  reportCheckerCapabilities(config, options.flow);

  for (const [stepIndex, step] of normalizedSteps.entries()) {
    const passed =
      step.type === 'task'
        ? await runBuiltinTask(config, step.name, options)
        : await runCommandStep(config, step, options);

    if (!passed) {
      const label = getPipelineStepLabel(step);

      pipelineTask?.fail(`default check blocked at ${label}`);

      for (const remainingStep of normalizedSteps.slice(stepIndex + 1)) {
        options.flow?.skip(`skipped: ${getPipelineStepLabel(remainingStep)}`, {
          depth: 1,
        });
      }

      return false;
    }
  }

  pipelineTask?.pass();

  return true;
}
