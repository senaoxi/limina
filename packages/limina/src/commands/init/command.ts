import { normalizeAbsolutePath } from '#utils/path';
import { createElapsedTimer } from 'logaria/helper';
import { clearCliScreen, formatErrorMessage, InitLogger } from '../../logger';
import {
  ensureGeneratedGraphGitignore,
  removeRootGeneratedGraphDir,
  writeLiminaConfig,
} from './files';
import { prepareInitMutationContext } from './mutation';
import { updateRootPackageJson } from './package-json';
import { readLiminaPackageMetadata } from './package-metadata';
import { runInitFlowStep } from './prompts';
import { liminaConfigFileName } from './shared';
import { installLiminaSkill } from './skill';
import type {
  InitFileState,
  InitFileStepResult,
  RunInitOptions,
  RunInitResult,
} from './types';
import {
  collectInitWorkspacePackages,
  resolveInitWorkspace,
} from './workspace';

type InitElapsedLogOptions = ReturnType<ReturnType<typeof createElapsedTimer>>;

interface InitCommandContext {
  options: RunInitOptions;
  rootDir: string;
  state: InitFileState;
  stepDepth: number;
  workspacePackageCount: number;
}

function getStepDepth(options: RunInitOptions): number {
  return (options.flowDepth ?? 0) + 1;
}

async function resolveWorkspaceStep(
  options: RunInitOptions,
  stepDepth: number,
): Promise<string> {
  const cwd = normalizeAbsolutePath(options.cwd ?? process.cwd());
  const result = await runInitFlowStep({
    action: async () => {
      const workspace = await resolveInitWorkspace({ cwd, prompt: options });
      return {
        message: `workspace root confirmed: ${workspace.rootDir}`,
        status: 'pass' as const,
        value: workspace,
      };
    },
    depth: stepDepth,
    flow: options.flow,
    label: 'resolve workspace root',
  });
  return result.rootDir;
}

async function countWorkspacePackages(options: {
  commandOptions: RunInitOptions;
  rootDir: string;
  stepDepth: number;
}): Promise<number> {
  const packages = await runInitFlowStep({
    action: async () => {
      const workspacePackages = await collectInitWorkspacePackages(
        options.rootDir,
      );
      return {
        message: `workspace packages checked: ${workspacePackages.length}`,
        status: 'pass' as const,
        value: workspacePackages,
      };
    },
    depth: options.stepDepth,
    flow: options.commandOptions.flow,
    label: 'validate workspace packages',
  });
  return packages.length;
}

async function createInitState(rootDir: string): Promise<InitFileState> {
  return {
    mutationContext: await prepareInitMutationContext({
      fileNames: [liminaConfigFileName, '.gitignore', 'package.json'],
      rootDir,
    }),
    removedPaths: [],
    skippedFiles: [],
    writtenFiles: [],
  };
}

async function createInitCommandContext(
  options: RunInitOptions,
): Promise<InitCommandContext> {
  const stepDepth = getStepDepth(options);
  const rootDir = await resolveWorkspaceStep(options, stepDepth);
  const workspacePackageCount = await countWorkspacePackages({
    commandOptions: options,
    rootDir,
    stepDepth,
  });
  return {
    options,
    rootDir,
    state: await createInitState(rootDir),
    stepDepth,
    workspacePackageCount,
  };
}

async function runFileStep(options: {
  action: () => Promise<InitFileStepResult>;
  context: InitCommandContext;
  label: string;
}): Promise<void> {
  await runInitFlowStep({
    action: async () => ({ ...(await options.action()), value: undefined }),
    depth: options.context.stepDepth,
    flow: options.context.options.flow,
    label: options.label,
  });
}

async function runWorkspaceFileSteps(
  context: InitCommandContext,
): Promise<void> {
  await runFileStep({
    action: () => removeRootGeneratedGraphDir(context.state),
    context,
    label: 'clean root .limina',
  });
  await runFileStep({
    action: () =>
      writeLiminaConfig({
        prompt: context.options,
        rootDir: context.rootDir,
        state: context.state,
      }),
    context,
    label: `write ${liminaConfigFileName}`,
  });
  await runFileStep({
    action: () =>
      ensureGeneratedGraphGitignore({
        rootDir: context.rootDir,
        state: context.state,
      }),
    context,
    label: 'ensure .gitignore',
  });
}

async function updatePackageJsonStep(
  context: InitCommandContext,
): Promise<boolean> {
  return runInitFlowStep({
    action: async () => {
      const result = await updateRootPackageJson({
        metadata: readLiminaPackageMetadata(),
        mutationContext: context.state.mutationContext,
        prompt: context.options,
        rootDir: context.rootDir,
        skippedFiles: context.state.skippedFiles,
        writtenFiles: context.state.writtenFiles,
      });
      return {
        message: result.message,
        status: result.status,
        value: result.installRequired,
      };
    },
    depth: context.stepDepth,
    flow: context.options.flow,
    label: 'update package.json',
  });
}

async function installSkillStep(context: InitCommandContext) {
  return runInitFlowStep({
    action: async () => {
      const result = await installLiminaSkill({
        rootDir: context.rootDir,
        yes: context.options.yes,
      });
      return {
        message: result.message,
        status: result.flowStatus,
        value: result.status,
      };
    },
    depth: context.stepDepth,
    flow: context.options.flow,
    label: 'install limina skill',
  });
}

async function runInitImpl(options: RunInitOptions): Promise<RunInitResult> {
  const context = await createInitCommandContext(options);
  await runWorkspaceFileSteps(context);
  const installRequired = await updatePackageJsonStep(context);
  const skillInstallStatus = await installSkillStep(context);
  return {
    buildCommand: 'pnpm limina:build',
    installRequired,
    removedPaths: context.state.removedPaths,
    rootDir: context.rootDir,
    skippedFiles: context.state.skippedFiles,
    skillInstallStatus,
    workspacePackageCount: context.workspacePackageCount,
    writtenFiles: context.state.writtenFiles,
  };
}

function initializeInitCommand(options: RunInitOptions): void {
  if (options.clearScreen ?? true) {
    clearCliScreen();
  }
  InitLogger.info('init started');
}

function getNextCommand(result: RunInitResult): string {
  return result.installRequired
    ? `pnpm i && ${result.buildCommand}`
    : result.buildCommand;
}

function reportInitSuccess(
  result: RunInitResult,
  elapsed: InitElapsedLogOptions,
): void {
  InitLogger.success(
    `init generated ${result.writtenFiles.length} files for ${result.workspacePackageCount} workspace packages.`,
    elapsed,
  );
  if (result.installRequired) {
    InitLogger.info(
      'limina dependencies were added to devDependencies; run pnpm i before building.',
    );
  }
  InitLogger.info(`next: ${getNextCommand(result)}`);
  InitLogger.info(
    'migration: run npx limina migration to move tsconfig output settings under Limina governance.',
  );
}

interface InitCommandTask {
  fail(reason: string, details: { error: unknown }): void;
  pass(): void;
}

function getFlowDepth(options: RunInitOptions): number {
  return options.flowDepth === undefined ? 0 : options.flowDepth;
}

function createInitTask(options: RunInitOptions): InitCommandTask | undefined {
  if (options.flow === undefined) {
    return undefined;
  }

  return options.flow.start('init workspace', {
    collapseOnSuccess: false,
    depth: getFlowDepth(options),
  });
}

function passInitTask(task: InitCommandTask | undefined): void {
  if (task !== undefined) {
    task.pass();
  }
}

function failInitTask(task: InitCommandTask | undefined, error: unknown): void {
  if (task !== undefined) {
    task.fail('init failed', { error });
  }
}

export async function runInit(
  options: RunInitOptions = {},
): Promise<RunInitResult> {
  initializeInitCommand(options);
  const elapsed = createElapsedTimer();
  const task = createInitTask(options);

  try {
    const result = await runInitImpl(options);
    reportInitSuccess(result, elapsed());
    passInitTask(task);
    return result;
  } catch (error) {
    InitLogger.error(`init failed: ${formatErrorMessage(error)}`, elapsed());
    failInitTask(task, error);
    throw error;
  }
}
