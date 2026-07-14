import type { ResolvedLiminaConfig } from '#config/runner';
import {
  collectWorkspacePackages,
  type PackageManifest,
  readJsonFile,
} from '#core/workspace/actions';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import * as prompts from '@clack/prompts';
import ignore from 'ignore';
import { createElapsedTimer } from 'logaria/helper';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'pathe';
import { parse as parseYaml } from 'yaml';
import type { LiminaFlowReporter } from '../flow';
import { clearCliScreen, formatErrorMessage, InitLogger } from '../logger';

export interface RunInitOptions {
  clearScreen?: boolean;
  cwd?: string;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  yes?: boolean;
}

export interface RunInitResult {
  buildCommand: string;
  installRequired: boolean;
  removedPaths: string[];
  rootDir: string;
  skippedFiles: string[];
  skillInstallStatus: InitSkillInstallStatus;
  workspacePackageCount: number;
  writtenFiles: string[];
}

export type InitSkillInstallStatus = 'failed' | 'installed' | 'skipped';

interface InitPromptOptions {
  yes?: boolean;
}

type InitFlowStepStatus = 'pass' | 'skip';

interface InitFlowStepResult<T> {
  message: string;
  status: InitFlowStepStatus;
  value: T;
}

interface InitFileStepResult {
  message: string;
  status: InitFlowStepStatus;
}

interface LiminaPackageMetadata {
  typescriptRange: string;
  versionRange: string;
}

interface RootPackageJsonUpdateResult extends InitFileStepResult {
  installRequired: boolean;
}

interface InitSkillInstallResult {
  flowStatus: InitFlowStepStatus;
  message: string;
  status: InitSkillInstallStatus;
}

const pnpmWorkspaceFileName = 'pnpm-workspace.yaml';
const liminaConfigFileName = 'limina.config.mts';
const liminaBuildScriptName = 'limina:build';
const liminaBuildScriptValue = 'limina checker build';
const liminaSkillInstallCommand = [
  'npx',
  '--yes',
  'skills',
  'add',
  'senaoxi/docs-islands',
  '--skill',
  'limina',
] as const;

function findPnpmWorkspaceRoot(startDir: string): string | null {
  let currentDir = path.resolve(startDir);

  while (true) {
    if (existsSync(path.join(currentDir, pnpmWorkspaceFileName))) {
      return normalizeAbsolutePath(currentDir);
    }

    const parentDir = path.dirname(currentDir);

    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

function createInitConfig(rootDir: string): ResolvedLiminaConfig {
  return {
    configPath: path.join(rootDir, liminaConfigFileName),
    rootDir,
  };
}

function formatConfigPath(rootDir: string, configPath: string): string {
  return toRelativePath(rootDir, configPath);
}

function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function createLiminaConfigContent(): string {
  return `import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      mode: 'auto',
      exclude: [],
    },
  },
});
`;
}

async function confirmAction(
  options: InitPromptOptions,
  message: string,
): Promise<boolean> {
  if (options.yes) {
    return true;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `${message} Run limina init --yes to accept the default confirmation in non-interactive environments.`,
    );
  }

  const result = await prompts.confirm({
    initialValue: true,
    message,
  });

  if (prompts.isCancel(result)) {
    throw new Error('limina init canceled.');
  }

  return result;
}

async function writeTextFile(
  filePath: string,
  content: string,
  writtenFiles: string[],
): Promise<void> {
  await mkdir(path.dirname(filePath), {
    recursive: true,
  });
  await writeFile(filePath, content);
  writtenFiles.push(filePath);
}

function formatCommand(command: readonly string[]): string {
  return command.join(' ');
}

async function runInitFlowStep<T>(options: {
  action: () => Promise<InitFlowStepResult<T>>;
  depth: number;
  flow?: LiminaFlowReporter;
  label: string;
}): Promise<T> {
  const task = options.flow?.start(options.label, {
    collapseOnSuccess: false,
    depth: options.depth,
  });

  try {
    const result = await options.action();

    if (result.status === 'skip') {
      task?.skip(result.message);
    } else {
      task?.pass(result.message);
    }

    return result.value;
  } catch (error) {
    task?.fail(`${options.label} failed`, {
      error,
    });
    throw error;
  }
}

function findPnpmWorkspacePath(startDir: string): string | null {
  const rootDir = findPnpmWorkspaceRoot(startDir);

  return rootDir ? path.join(rootDir, pnpmWorkspaceFileName) : null;
}

function resolveCatalogRange(
  range: string | undefined,
  packageName: string,
  packageManifestPath: string,
): string | null {
  if (!range) {
    return null;
  }

  if (!range.startsWith('catalog:')) {
    return range;
  }

  const workspacePath = findPnpmWorkspacePath(
    path.dirname(packageManifestPath),
  );

  if (!workspacePath || !existsSync(workspacePath)) {
    return null;
  }

  const parsed = parseYaml(readFileSync(workspacePath, 'utf8')) as {
    catalog?: Record<string, string>;
    catalogs?: Record<string, Record<string, string>>;
  } | null;
  const catalogName = range.slice('catalog:'.length);

  if (catalogName.length === 0 || catalogName === 'default') {
    return parsed?.catalog?.[packageName] ?? null;
  }

  return parsed?.catalogs?.[catalogName]?.[packageName] ?? null;
}

function readLiminaPackageMetadata(): LiminaPackageMetadata {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('limina/package.json');
  const manifest = readJsonFile<PackageManifest & { version?: string }>(
    manifestPath,
  );
  const versionRange = manifest.version ? `^${manifest.version}` : '^0.0.1';
  const rawTypeScriptRange =
    manifest.peerDependencies?.typescript ??
    manifest.devDependencies?.typescript ??
    manifest.dependencies?.typescript;
  const typescriptRange =
    resolveCatalogRange(rawTypeScriptRange, 'typescript', manifestPath) ??
    rawTypeScriptRange ??
    '^5.9.0';

  return {
    typescriptRange,
    versionRange,
  };
}

function hasDependency(
  manifest: PackageManifest,
  dependencyName: string,
): boolean {
  return Boolean(
    manifest.dependencies?.[dependencyName] ||
      manifest.devDependencies?.[dependencyName] ||
      manifest.optionalDependencies?.[dependencyName] ||
      manifest.peerDependencies?.[dependencyName],
  );
}

async function updateRootPackageJson(options: {
  metadata: LiminaPackageMetadata;
  prompt: InitPromptOptions;
  rootDir: string;
  skippedFiles: string[];
  writtenFiles: string[];
}): Promise<RootPackageJsonUpdateResult> {
  const packageJsonPath = path.join(options.rootDir, 'package.json');
  let installRequired = false;

  if (!existsSync(packageJsonPath)) {
    const shouldCreate = await confirmAction(
      options.prompt,
      `No package.json found at ${formatConfigPath(options.rootDir, packageJsonPath)}. Create one?`,
    );

    if (!shouldCreate) {
      options.skippedFiles.push(packageJsonPath);
      return {
        installRequired: false,
        message: 'package.json (skipped: creation declined)',
        status: 'skip',
      };
    }

    const manifest: PackageManifest = {
      private: true,
      type: 'module',
      scripts: {
        [liminaBuildScriptName]: liminaBuildScriptValue,
      },
      devDependencies: {
        limina: options.metadata.versionRange,
        typescript: options.metadata.typescriptRange,
      },
    };

    await writeTextFile(
      packageJsonPath,
      stringifyJson(manifest),
      options.writtenFiles,
    );

    return {
      installRequired: true,
      message: 'package.json created',
      status: 'pass',
    };
  }

  const manifest = readJsonFile<PackageManifest>(packageJsonPath);
  const scripts = {
    ...manifest.scripts,
  };
  let changed = false;

  if (
    scripts[liminaBuildScriptName] &&
    scripts[liminaBuildScriptName] !== liminaBuildScriptValue
  ) {
    const shouldOverwrite = await confirmAction(
      options.prompt,
      `Script "${liminaBuildScriptName}" already exists in package.json. Overwrite it?`,
    );

    if (shouldOverwrite) {
      scripts[liminaBuildScriptName] = liminaBuildScriptValue;
      changed = true;
    }
  } else if (!scripts[liminaBuildScriptName]) {
    scripts[liminaBuildScriptName] = liminaBuildScriptValue;
    changed = true;
  }

  if (!hasDependency(manifest, 'limina')) {
    manifest.devDependencies = {
      ...manifest.devDependencies,
      limina: options.metadata.versionRange,
    };
    installRequired = true;
    changed = true;
  }

  if (!hasDependency(manifest, 'typescript')) {
    manifest.devDependencies = {
      ...manifest.devDependencies,
      typescript: options.metadata.typescriptRange,
    };
    installRequired = true;
    changed = true;
  }

  if (changed) {
    await writeTextFile(
      packageJsonPath,
      stringifyJson({
        ...manifest,
        scripts,
      }),
      options.writtenFiles,
    );
    return {
      installRequired,
      message: 'package.json updated',
      status: 'pass',
    };
  }

  options.skippedFiles.push(packageJsonPath);
  return {
    installRequired,
    message: 'package.json (skipped: script and dependencies already present)',
    status: 'skip',
  };
}

async function writeLiminaConfig(options: {
  prompt: InitPromptOptions;
  rootDir: string;
  skippedFiles: string[];
  writtenFiles: string[];
}): Promise<InitFileStepResult> {
  const configPath = path.join(options.rootDir, liminaConfigFileName);
  const content = createLiminaConfigContent();

  if (existsSync(configPath)) {
    if (readFileSync(configPath, 'utf8') === content) {
      options.skippedFiles.push(configPath);
      return {
        message: `${liminaConfigFileName} (skipped: already up to date)`,
        status: 'skip',
      };
    }

    const shouldOverwrite = await confirmAction(
      options.prompt,
      `${liminaConfigFileName} already exists. Overwrite it?`,
    );

    if (!shouldOverwrite) {
      options.skippedFiles.push(configPath);
      return {
        message: `${liminaConfigFileName} (skipped: existing file kept)`,
        status: 'skip',
      };
    }
  }

  await writeTextFile(configPath, content, options.writtenFiles);
  return {
    message: `${liminaConfigFileName} written`,
    status: 'pass',
  };
}

async function ensureGeneratedGraphGitignore(options: {
  rootDir: string;
  skippedFiles: string[];
  writtenFiles: string[];
}): Promise<InitFileStepResult> {
  const gitignorePath = path.join(options.rootDir, '.gitignore');
  const entry = '.limina/';

  if (!existsSync(gitignorePath)) {
    await writeTextFile(gitignorePath, `${entry}\n`, options.writtenFiles);
    return {
      message: '.gitignore created',
      status: 'pass',
    };
  }

  const content = readFileSync(gitignorePath, 'utf8');
  const ig = ignore().add(content);

  if (ig.ignores(entry)) {
    options.skippedFiles.push(gitignorePath);
    return {
      message: '.gitignore (skipped: .limina/ already ignored)',
      status: 'skip',
    };
  }

  const separator = content.endsWith('\n') || content.length === 0 ? '' : '\n';

  await writeTextFile(
    gitignorePath,
    `${content}${separator}${entry}\n`,
    options.writtenFiles,
  );

  return {
    message: '.gitignore updated',
    status: 'pass',
  };
}

async function removeRootGeneratedGraphDir(options: {
  removedPaths: string[];
  rootDir: string;
}): Promise<InitFileStepResult> {
  const generatedRootPath = path.join(options.rootDir, '.limina');

  if (!existsSync(generatedRootPath)) {
    return {
      message: 'root .limina (skipped: not present)',
      status: 'skip',
    };
  }

  await rm(generatedRootPath, {
    force: true,
    recursive: true,
  });
  options.removedPaths.push(generatedRootPath);
  return {
    message: 'root .limina removed',
    status: 'pass',
  };
}

function runCommand(
  command: readonly [string, ...string[]],
  cwd: string,
): Promise<void> {
  const [bin, ...args] = command;

  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        cwd,
      },
      (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      },
    );
  });
}

async function promptOptionalAction(
  message: string,
): Promise<'accepted' | 'rejected' | 'unavailable'> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return 'unavailable';
  }

  const result = await prompts.confirm({
    initialValue: true,
    message,
  });

  if (prompts.isCancel(result) || result !== true) {
    return 'rejected';
  }

  return 'accepted';
}

async function installLiminaSkill(options: {
  rootDir: string;
  yes?: boolean;
}): Promise<InitSkillInstallResult> {
  const command = formatCommand(liminaSkillInstallCommand);

  if (options.yes) {
    InitLogger.info(`skill install skipped; run ${command} to install it.`);
    return {
      flowStatus: 'skip',
      message: `limina skill (skipped: --yes; run ${command})`,
      status: 'skipped',
    };
  }

  const promptResult = await promptOptionalAction(
    'Install the Limina agent skill for this project?',
  );

  if (promptResult !== 'accepted') {
    InitLogger.info(`skill install skipped; run ${command} to install it.`);
    return {
      flowStatus: 'skip',
      message:
        promptResult === 'unavailable'
          ? `limina skill (skipped: non-interactive; run ${command})`
          : `limina skill (skipped: declined; run ${command})`,
      status: 'skipped',
    };
  }

  try {
    await runCommand(liminaSkillInstallCommand, options.rootDir);
    InitLogger.success('limina skill installed.');
    return {
      flowStatus: 'pass',
      message: 'limina skill installed',
      status: 'installed',
    };
  } catch (error) {
    InitLogger.warn(
      [
        `limina skill install failed: ${formatErrorMessage(error)}`,
        `retry: ${command}`,
      ].join('\n'),
    );
    return {
      flowStatus: 'skip',
      message: `limina skill (skipped: install failed; retry: ${command})`,
      status: 'failed',
    };
  }
}

async function runInitImpl(options: RunInitOptions): Promise<RunInitResult> {
  const cwd = normalizeAbsolutePath(options.cwd ?? process.cwd());
  const stepDepth = (options.flowDepth ?? 0) + 1;
  const { rootDir } = await runInitFlowStep({
    action: async () => {
      const rootDir = findPnpmWorkspaceRoot(cwd);

      if (!rootDir) {
        throw new Error(
          `Unable to run limina init from ${cwd}: no pnpm-workspace.yaml was found in this directory or its parents.`,
        );
      }

      const rootPackageJsonPath = path.join(rootDir, 'package.json');
      const rootPackageName = existsSync(rootPackageJsonPath)
        ? readJsonFile<PackageManifest>(rootPackageJsonPath).name
        : undefined;
      const shouldUseRoot = await confirmAction(
        options,
        `Use pnpm workspace ${rootPackageName ? `"${rootPackageName}" ` : ''}at ${rootDir}?`,
      );

      if (!shouldUseRoot) {
        throw new Error('limina init canceled.');
      }

      return {
        message: `workspace root confirmed: ${rootDir}`,
        status: 'pass',
        value: {
          rootDir,
        },
      };
    },
    depth: stepDepth,
    flow: options.flow,
    label: 'resolve workspace root',
  });
  const config = createInitConfig(rootDir);

  const workspacePackages = await runInitFlowStep({
    action: async () => {
      const workspacePackages = (await collectWorkspacePackages(config)).filter(
        (workspacePackage) => workspacePackage.directory !== rootDir,
      );

      return {
        message: `workspace packages checked: ${workspacePackages.length}`,
        status: 'pass',
        value: workspacePackages,
      };
    },
    depth: stepDepth,
    flow: options.flow,
    label: 'validate workspace packages',
  });

  const metadata = readLiminaPackageMetadata();
  const removedPaths: string[] = [];
  const writtenFiles: string[] = [];
  const skippedFiles: string[] = [];

  await runInitFlowStep({
    action: async () => ({
      ...(await removeRootGeneratedGraphDir({
        removedPaths,
        rootDir,
      })),
      value: undefined,
    }),
    depth: stepDepth,
    flow: options.flow,
    label: 'clean root .limina',
  });
  await runInitFlowStep({
    action: async () => ({
      ...(await writeLiminaConfig({
        prompt: options,
        rootDir,
        skippedFiles,
        writtenFiles,
      })),
      value: undefined,
    }),
    depth: stepDepth,
    flow: options.flow,
    label: `write ${liminaConfigFileName}`,
  });
  await runInitFlowStep({
    action: async () => ({
      ...(await ensureGeneratedGraphGitignore({
        rootDir,
        skippedFiles,
        writtenFiles,
      })),
      value: undefined,
    }),
    depth: stepDepth,
    flow: options.flow,
    label: 'ensure .gitignore',
  });
  const installRequired = await runInitFlowStep({
    action: async () => {
      const result = await updateRootPackageJson({
        metadata,
        prompt: options,
        rootDir,
        skippedFiles,
        writtenFiles,
      });

      return {
        message: result.message,
        status: result.status,
        value: result.installRequired,
      };
    },
    depth: stepDepth,
    flow: options.flow,
    label: 'update package.json',
  });
  const skillInstallStatus = await runInitFlowStep({
    action: async () => {
      const result = await installLiminaSkill({
        rootDir,
        yes: options.yes,
      });

      return {
        message: result.message,
        status: result.flowStatus,
        value: result.status,
      };
    },
    depth: stepDepth,
    flow: options.flow,
    label: 'install limina skill',
  });

  return {
    buildCommand: 'pnpm limina:build',
    installRequired,
    removedPaths,
    rootDir,
    skippedFiles,
    skillInstallStatus,
    workspacePackageCount: workspacePackages.length,
    writtenFiles,
  };
}

export async function runInit(
  options: RunInitOptions = {},
): Promise<RunInitResult> {
  if (options.clearScreen ?? true) {
    clearCliScreen();
  }

  const elapsed = createElapsedTimer();
  const task = options.flow?.start('init workspace', {
    collapseOnSuccess: false,
    depth: options.flowDepth ?? 0,
  });

  InitLogger.info('init started');

  try {
    const result = await runInitImpl(options);

    InitLogger.success(
      `init generated ${result.writtenFiles.length} files for ${result.workspacePackageCount} workspace packages.`,
      elapsed(),
    );

    if (result.installRequired) {
      InitLogger.info(
        'limina dependencies were added to devDependencies; run pnpm i before building.',
      );
    }

    InitLogger.info(
      `next: ${result.installRequired ? 'pnpm i && ' : ''}${result.buildCommand}`,
    );
    InitLogger.info(
      'migration: run npx limina migration to move tsconfig output settings under Limina governance.',
    );
    task?.pass();

    return result;
  } catch (error) {
    InitLogger.error(`init failed: ${formatErrorMessage(error)}`, elapsed());
    task?.fail('init failed', { error });
    throw error;
  }
}
