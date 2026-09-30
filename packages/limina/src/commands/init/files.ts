import ignore from 'ignore';
import { existsSync, readFileSync } from 'node:fs';
import path from 'pathe';
import { removeInitGeneratedRoot } from './mutation';
import { isConfirmAction } from './prompts';
import {
  createLiminaConfigContent,
  liminaConfigFileName,
  writeTextFile,
} from './shared';
import type {
  InitFileState,
  InitFileStepResult,
  InitPromptOptions,
} from './types';

type FileWritePlan =
  | { message: string; status: 'skip' }
  | { content: string; message: string; status: 'pass' };

function createSkippedPlan(message: string): FileWritePlan {
  return { message, status: 'skip' };
}

function createConfigWritePlan(content: string): FileWritePlan {
  return {
    content,
    message: `${liminaConfigFileName} written`,
    status: 'pass',
  };
}

async function resolveExistingConfigPlan(options: {
  configPath: string;
  content: string;
  prompt: InitPromptOptions;
}): Promise<FileWritePlan> {
  if (readFileSync(options.configPath, 'utf8') === options.content) {
    return createSkippedPlan(
      `${liminaConfigFileName} (skipped: already up to date)`,
    );
  }

  const shouldOverwrite = await isConfirmAction({
    message: `${liminaConfigFileName} already exists. Overwrite it?`,
    prompt: options.prompt,
  });
  return shouldOverwrite
    ? createConfigWritePlan(options.content)
    : createSkippedPlan(
        `${liminaConfigFileName} (skipped: existing file kept)`,
      );
}

async function resolveConfigWritePlan(options: {
  configPath: string;
  prompt: InitPromptOptions;
}): Promise<FileWritePlan> {
  const content = createLiminaConfigContent();
  return existsSync(options.configPath)
    ? resolveExistingConfigPlan({ ...options, content })
    : createConfigWritePlan(content);
}

async function applyFileWritePlan(options: {
  filePath: string;
  plan: FileWritePlan;
  state: InitFileState;
}): Promise<InitFileStepResult> {
  if (options.plan.status === 'skip') {
    options.state.skippedFiles.push(options.filePath);
    return options.plan;
  }

  await writeTextFile({
    content: options.plan.content,
    filePath: options.filePath,
    mutationContext: options.state.mutationContext,
    writtenFiles: options.state.writtenFiles,
  });
  return options.plan;
}

export async function writeLiminaConfig(options: {
  prompt: InitPromptOptions;
  rootDir: string;
  state: InitFileState;
}): Promise<InitFileStepResult> {
  const configPath = path.join(options.rootDir, liminaConfigFileName);
  const plan = await resolveConfigWritePlan({
    configPath,
    prompt: options.prompt,
  });
  return applyFileWritePlan({
    filePath: configPath,
    plan,
    state: options.state,
  });
}

function getGitignoreSeparator(content: string): string {
  return content.length === 0 || content.endsWith('\n') ? '' : '\n';
}

function createExistingGitignorePlan(
  content: string,
  entry: string,
): FileWritePlan {
  if (ignore().add(content).ignores(entry)) {
    return createSkippedPlan('.gitignore (skipped: .limina/ already ignored)');
  }

  return {
    content: `${content}${getGitignoreSeparator(content)}${entry}\n`,
    message: '.gitignore updated',
    status: 'pass',
  };
}

function createGitignorePlan(gitignorePath: string): FileWritePlan {
  const entry = '.limina/';
  if (!existsSync(gitignorePath)) {
    return {
      content: `${entry}\n`,
      message: '.gitignore created',
      status: 'pass',
    };
  }

  return createExistingGitignorePlan(
    readFileSync(gitignorePath, 'utf8'),
    entry,
  );
}

export async function ensureGeneratedGraphGitignore(options: {
  rootDir: string;
  state: InitFileState;
}): Promise<InitFileStepResult> {
  const gitignorePath = path.join(options.rootDir, '.gitignore');
  return applyFileWritePlan({
    filePath: gitignorePath,
    plan: createGitignorePlan(gitignorePath),
    state: options.state,
  });
}

async function removeRootGeneratedGraphDirectory(
  state: InitFileState,
): Promise<InitFileStepResult> {
  const generatedRootPath = state.mutationContext.generatedRootPath;
  const isRemoved = await removeInitGeneratedRoot(state.mutationContext);
  if (!isRemoved) {
    return {
      message: 'root .limina (skipped: not present)',
      status: 'skip',
    };
  }

  state.removedPaths.push(generatedRootPath);
  return {
    message: 'root .limina removed',
    status: 'pass',
  };
}

export { removeRootGeneratedGraphDirectory as removeRootGeneratedGraphDir };
