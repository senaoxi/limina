import { createLogger } from '@limina/build-tools/logger';
import { createElapsedTimer, formatErrorMessage } from 'logaria/helper';
import type { LoggerLogOptions } from 'logaria/types';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import prompts from 'prompts';
import semver from 'semver';

const loggerInstance = createLogger({
  main: 'limina',
});

type BaseLogger = ReturnType<typeof loggerInstance.getLoggerByGroup>;

interface LoggerFacade {
  error(message: string, options?: LoggerLogOptions): void;
  info(message: string, options?: LoggerLogOptions): void;
  success(message: string, options?: LoggerLogOptions): void;
  warn(message: string, options?: LoggerLogOptions): void;
}

interface PromptInterface {
  close(): void;
  question(message: string): Promise<string>;
}

function createScriptLogger(baseLogger: BaseLogger): LoggerFacade {
  return {
    info(message, options) {
      baseLogger.info(message, options);
    },
    warn(message, options) {
      baseLogger.warn(message, options);
    },
    error(message, options) {
      baseLogger.error(message, options);
    },
    success(message, options) {
      baseLogger.success(message, options);
    },
  };
}

function createPrompt(): PromptInterface {
  const interfaceInstance = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return {
    close() {
      interfaceInstance.close();
    },
    question(message) {
      return new Promise<string>((resolve) => {
        interfaceInstance.question(message, (answer) => {
          resolve(answer);
        });
      });
    },
  };
}

export const ReleaseLogger = createScriptLogger(
  loggerInstance.getLoggerByGroup('task.release.workspace'),
);
export const ChangelogLogger = createScriptLogger(
  loggerInstance.getLoggerByGroup('task.changelog.workspace'),
);

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const WORKSPACE_CONFIG_PATH = path.join(
  REPO_ROOT,
  'pnpm-workspace.yaml',
);
export const REPOSITORY_URL = 'https://github.com/senaoxi/limina';

export type ReleaseType = 'patch' | 'minor' | 'major' | 'prerelease';
export type VersionSelectionMode = ReleaseType | 'custom';

export interface ReleasePackageManifest {
  name?: string;
  version?: string;
  private?: boolean;
  publishConfig?: {
    access?: string;
  };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export interface ReleasePackageConfig {
  key: 'limina';
  packageName: string;
  relativeDir: string;
  publishRelativeDir: string;
  changelogRelativePath: string;
  changelogPaths: string[];
  tagPrefix: string;
  legacyTagPrefix?: string;
  previewChecks: string[];
}

export interface ResolvedReleasePackageConfig extends ReleasePackageConfig {
  packageDir: string;
  publishDir: string;
  changelogPath: string;
  manifestPath: string;
  manifest: ReleasePackageManifest;
}

export interface ReleasePlan {
  config: ResolvedReleasePackageConfig;
  currentVersion: string;
  newVersion: string;
  gitTag: string;
  npmTag: string | undefined;
}

export interface ReleaseCliOptions {
  packageSelectors: string[];
  type?: ReleaseType;
  version?: string;
  preId?: string;
  dryRun: boolean;
  yes: boolean;
  skipTests: boolean;
  skipBuild: boolean;
  skipChangelog: boolean;
  skipNpmPublish: boolean;
  skipPush: boolean;
  fromTag?: string;
  registry?: string;
  npmTag?: string;
  provenance: boolean;
  help: boolean;
}

export interface PublishCliOptions {
  packageSelectors: string[];
  dryRun: boolean;
  skipTests: boolean;
  skipBuild: boolean;
  registry?: string;
  npmTag?: string;
  provenance: boolean;
  help: boolean;
}

export interface ChangelogCliOptions {
  packageSelectors: string[];
  type?: ReleaseType;
  version?: string;
  preId?: string;
  dryRun: boolean;
  fromTag?: string;
  help: boolean;
}

export interface VersionParts {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

export interface PromptVersionSelection {
  mode: VersionSelectionMode;
  version?: string;
  preId?: string;
}

export interface PromptPackageSelectionResult {
  packageSelectors: string[];
}

export interface PromptMultiselectChoice {
  title: string;
  value: string;
  selected?: boolean;
}

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: 'inherit' | 'pipe';
  allowFailure?: boolean;
  logger?: LoggerFacade;
}

const RELEASE_PACKAGE_CONFIGS: readonly ReleasePackageConfig[] = [
  {
    key: 'limina',
    packageName: 'limina',
    relativeDir: 'packages/limina',
    publishRelativeDir: 'packages/limina/dist',
    changelogRelativePath: 'packages/limina/CHANGELOG.md',
    changelogPaths: ['.'],
    tagPrefix: 'limina',
    previewChecks: [
      'test',
      'smoke',
      'build package',
      'verify dist/package.json version',
      'limina package check',
      'limina release check',
      'npm pack --dry-run',
    ],
  },
] as const;

export const ALL_RELEASE_PACKAGES_SELECTION = '__all_release_packages__';

export function getReleasePackageConfigs(): readonly ReleasePackageConfig[] {
  return RELEASE_PACKAGE_CONFIGS;
}

export function getPnpmCommand(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

export function getNpmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

export function getGitCommand(): string {
  return process.platform === 'win32' ? 'git.exe' : 'git';
}

export function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

export function writeJsonFile(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function readPackageManifest(
  manifestPath: string,
): ReleasePackageManifest {
  return readJsonFile<ReleasePackageManifest>(manifestPath);
}

export function resolvePackageConfig(
  config: ReleasePackageConfig,
): ResolvedReleasePackageConfig {
  const packageDir = path.join(REPO_ROOT, config.relativeDir);
  const manifestPath = path.join(packageDir, 'package.json');
  const publishDir = path.join(REPO_ROOT, config.publishRelativeDir);
  const changelogPath = path.join(REPO_ROOT, config.changelogRelativePath);

  return {
    ...config,
    packageDir,
    publishDir,
    changelogPath,
    manifestPath,
    manifest: readPackageManifest(manifestPath),
  };
}

export function discoverReleasePackages(): ResolvedReleasePackageConfig[] {
  return getReleasePackageConfigs()
    .map((config) => resolvePackageConfig(config))
    .filter((config) => {
      const { manifest } = config;
      return (
        manifest.private !== true &&
        manifest.publishConfig?.access === 'public' &&
        typeof manifest.version === 'string'
      );
    });
}

export function getPackageDisplayName(
  config: Pick<ReleasePackageConfig, 'key' | 'packageName'>,
): string {
  return `${config.key} (${config.packageName})`;
}

export function normalizePackageSelector(selector: string): string {
  return selector.trim();
}

export function resolvePackageSelections(
  selectors: string[],
  configs: ResolvedReleasePackageConfig[],
): ResolvedReleasePackageConfig[] {
  const configBySelector = new Map<string, ResolvedReleasePackageConfig>();

  for (const config of configs) {
    configBySelector.set(config.key, config);
    configBySelector.set(config.packageName, config);
  }

  const resolved: ResolvedReleasePackageConfig[] = [];
  const seen = new Set<string>();

  for (const selector of selectors.map(normalizePackageSelector)) {
    const config = configBySelector.get(selector);
    if (!config) {
      throw new Error(
        `Unsupported release package: ${selector}. Available packages: ${configs
          .map((item) => item.key)
          .join(', ')}`,
      );
    }
    if (!seen.has(config.packageName)) {
      resolved.push(config);
      seen.add(config.packageName);
    }
  }

  return resolved;
}

export function getInternalDependencyNames(
  manifest: ReleasePackageManifest,
): Set<string> {
  const names = new Set<string>();
  // Release ordering follows publish-facing contracts. Dev dependencies can
  // point back to local release tooling and create false package cycles.
  const dependencyMaps = [manifest.dependencies, manifest.peerDependencies];

  for (const dependencyMap of dependencyMaps) {
    if (!dependencyMap) {
      continue;
    }
    for (const dependencyName of Object.keys(dependencyMap)) {
      names.add(dependencyName);
    }
  }

  return names;
}

export function sortReleasePackageConfigs(
  configs: ResolvedReleasePackageConfig[],
): ResolvedReleasePackageConfig[] {
  const configByName = new Map(
    configs.map((config) => [config.packageName, config] as const),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: ResolvedReleasePackageConfig[] = [];

  const visit = (config: ResolvedReleasePackageConfig): void => {
    if (visited.has(config.packageName)) {
      return;
    }
    if (visiting.has(config.packageName)) {
      throw new Error(
        `Circular release dependency detected around ${config.packageName}`,
      );
    }

    visiting.add(config.packageName);
    const internalDependencies = getInternalDependencyNames(config.manifest);
    for (const dependencyName of internalDependencies) {
      const dependencyConfig = configByName.get(dependencyName);
      if (dependencyConfig) {
        visit(dependencyConfig);
      }
    }
    visiting.delete(config.packageName);
    visited.add(config.packageName);
    ordered.push(config);
  };

  for (const config of configs) {
    visit(config);
  }

  return ordered;
}

export function parseVersion(version: string): VersionParts {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([\dA-Za-z.-]+))?$/.exec(version);
  if (!match) {
    throw new Error(`Invalid version format: ${version}`);
  }

  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: match[4],
  };
}

export function isValidVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[\dA-Za-z.-]+)?$/.test(version);
}

export function isReleaseType(value: string): value is ReleaseType {
  return (
    value === 'patch' ||
    value === 'minor' ||
    value === 'major' ||
    value === 'prerelease'
  );
}

export function compareVersions(a: string, b: string): number {
  parseVersion(a);
  parseVersion(b);
  return semver.compare(a, b);
}

export function incrementVersion(
  version: string,
  type: ReleaseType,
  preId?: string,
): string {
  const parsed = parseVersion(version);

  switch (type) {
    case 'patch':
      parsed.patch++;
      parsed.prerelease = undefined;
      break;
    case 'minor':
      parsed.minor++;
      parsed.patch = 0;
      parsed.prerelease = undefined;
      break;
    case 'major':
      parsed.major++;
      parsed.minor = 0;
      parsed.patch = 0;
      parsed.prerelease = undefined;
      break;
    case 'prerelease': {
      if (parsed.prerelease) {
        const prereleaseMatch = /^(.+)\.(\d+)$/.exec(parsed.prerelease);
        if (prereleaseMatch) {
          parsed.prerelease = `${prereleaseMatch[1]}.${
            Number.parseInt(prereleaseMatch[2], 10) + 1
          }`;
        } else {
          parsed.prerelease = `${parsed.prerelease}.1`;
        }
      } else {
        parsed.patch++;
        parsed.prerelease = `${preId || 'alpha'}.0`;
      }
      break;
    }
  }

  return formatVersion(parsed);
}

export function formatVersion(version: VersionParts): string {
  const base = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease ? `${base}-${version.prerelease}` : base;
}

export function resolveNextVersion(
  currentVersion: string,
  selection: PromptVersionSelection,
): string {
  if (selection.mode === 'custom') {
    if (!selection.version || !isValidVersion(selection.version)) {
      throw new Error(`Invalid version: ${selection.version}`);
    }
    return selection.version;
  }

  return incrementVersion(currentVersion, selection.mode, selection.preId);
}

export function resolveDefaultNpmTag(
  version: string,
  explicitTag?: string,
  preId?: string,
): string | undefined {
  if (explicitTag) {
    return explicitTag;
  }

  const parsed = parseVersion(version);
  if (!parsed.prerelease) {
    return undefined;
  }

  if (preId) {
    return preId;
  }

  const [prereleaseId] = parsed.prerelease.split('.');
  return prereleaseId || 'next';
}

export function createGitTag(
  config: Pick<ReleasePackageConfig, 'tagPrefix'>,
  version: string,
): string {
  return `${config.tagPrefix}/v${version}`;
}

export function readPublishBranch(): string {
  const source = readFileSync(WORKSPACE_CONFIG_PATH, 'utf8');
  const match = /^publishBranch:\s*(.+)$/m.exec(source);
  if (!match) {
    return 'main';
  }
  return match[1].trim();
}

export function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {},
): string {
  const {
    cwd = REPO_ROOT,
    env,
    stdio = 'pipe',
    allowFailure = false,
    logger = ReleaseLogger,
  } = options;
  const commandText = [command, ...args].join(' ');
  logger.info(`command started: ${commandText}`);
  const commandElapsed = createElapsedTimer();

  try {
    return execFileSync(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio,
      encoding: 'utf8',
    });
  } catch (error) {
    if (allowFailure) {
      return '';
    }
    logger.error(
      `command failed: ${commandText}\nreason: ${formatErrorMessage(error)}`,
      commandElapsed(),
    );
    throw error;
  }
}

export function readGitTags(): string[] {
  const output = runCommand(getGitCommand(), ['tag', '--list'], {
    logger: ReleaseLogger,
  }).trim();
  if (!output) {
    return [];
  }
  return output
    .split('\n')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function selectPreviousGitTag(
  config: Pick<ReleasePackageConfig, 'tagPrefix' | 'legacyTagPrefix'>,
  tags: string[],
): string | undefined {
  const packageTags = tags.filter((tag) =>
    tag.startsWith(`${config.tagPrefix}/v`),
  );

  if (packageTags.length > 0) {
    return sortTagsByVersion(packageTags)[0];
  }

  if (!config.legacyTagPrefix) {
    return undefined;
  }

  const legacyTags = tags.filter((tag) =>
    tag.startsWith(config.legacyTagPrefix!),
  );
  if (legacyTags.length === 0) {
    return undefined;
  }
  return sortTagsByVersion(legacyTags)[0];
}

export function sortTagsByVersion(tags: string[]): string[] {
  return [...tags].sort((left, right) => {
    const leftVersion = left.replace(/^.+\/v/, '').replace(/^v/, '');
    const rightVersion = right.replace(/^.+\/v/, '').replace(/^v/, '');
    return compareVersions(rightVersion, leftVersion);
  });
}

export function splitCsvValues(rawValue: string): string[] {
  return rawValue
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function createReleasePackageSelectionChoices(
  configs: ResolvedReleasePackageConfig[],
): PromptMultiselectChoice[] {
  return [
    {
      title: 'all public packages',
      value: ALL_RELEASE_PACKAGES_SELECTION,
      selected: configs.length === 1,
    },
    ...configs.map((config) => ({
      title: `${config.key} (${config.packageName}@${config.manifest.version})`,
      value: config.key,
    })),
  ];
}

export function normalizePromptPackageSelections(
  selectedValues: readonly string[],
  configs: ResolvedReleasePackageConfig[],
): PromptPackageSelectionResult {
  const selectedSet = new Set(selectedValues);
  const packageSelectors = selectedSet.has(ALL_RELEASE_PACKAGES_SELECTION)
    ? configs.map((config) => config.key)
    : configs
        .filter((config) => selectedSet.has(config.key))
        .map((config) => config.key);

  return {
    packageSelectors,
  };
}

export async function promptForPackageSelections(
  configs: ResolvedReleasePackageConfig[],
  question: string,
): Promise<PromptPackageSelectionResult> {
  const { selectedPackageKeys = [] } = await prompts(
    {
      type: 'multiselect',
      name: 'selectedPackageKeys',
      message: question,
      choices: createReleasePackageSelectionChoices(configs),
      min: 1,
    },
    {
      onCancel() {
        throw new Error('Release cancelled');
      },
    },
  );

  process.stdout.write('\n');

  const normalized = normalizePromptPackageSelections(
    selectedPackageKeys,
    configs,
  );
  if (normalized.packageSelectors.length === 0) {
    throw new Error('Please choose at least one valid package to continue.');
  }

  return normalized;
}

export async function promptForVersionSelection(
  config: ResolvedReleasePackageConfig,
): Promise<PromptVersionSelection> {
  const rl = createPrompt();

  try {
    while (true) {
      process.stdout.write(
        [
          `Choose version strategy for ${config.key} (${config.manifest.version}):`,
          '  1. patch',
          '  2. minor',
          '  3. major',
          '  4. prerelease',
          '  5. custom version',
        ].join('\n') + '\n',
      );
      const answer = (
        await rl.question('Select an option (default: 1): ')
      ).trim();
      const normalized = answer || '1';

      if (normalized === '1') {
        return { mode: 'patch' };
      }
      if (normalized === '2') {
        return { mode: 'minor' };
      }
      if (normalized === '3') {
        return { mode: 'major' };
      }
      if (normalized === '4') {
        const preId = (
          await rl.question('Prerelease id (default: alpha): ')
        ).trim();
        return { mode: 'prerelease', preId: preId || 'alpha' };
      }
      if (normalized === '5') {
        const version = (await rl.question('Custom version: ')).trim();
        if (isValidVersion(version)) {
          return { mode: 'custom', version };
        }
        process.stdout.write(`Invalid version: ${version}\n`);
        continue;
      }

      process.stdout.write(`Unknown selection: ${normalized}\n`);
    }
  } finally {
    rl.close();
  }
}

export async function promptForExecutionMode(): Promise<{
  dryRun: boolean;
  confirmed: boolean;
}> {
  const rl = createPrompt();

  try {
    const modeAnswer = (
      await rl.question('Run mode: 1) dry-run  2) publish (default: 1): ')
    ).trim();
    const dryRun = modeAnswer !== '2';
    const confirmAnswer = (
      await rl.question(
        dryRun
          ? 'Preview this release plan? [Y/n]: '
          : 'Proceed with publish? [y/N]: ',
      )
    ).trim();
    const confirmed = dryRun
      ? confirmAnswer.toLowerCase() !== 'n'
      : confirmAnswer.toLowerCase() === 'y';
    return { dryRun, confirmed };
  } finally {
    rl.close();
  }
}

export async function promptForChangelogReview(
  plans: ReleasePlan[],
): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error(
      'Changelog generation requires manual review in an interactive terminal. Run release in a TTY, or update the changelog first and pass --skip-changelog.',
    );
  }

  const changelogPaths = [
    ...new Set(
      plans.map((plan) => path.relative(REPO_ROOT, plan.config.changelogPath)),
    ),
  ];

  ReleaseLogger.warn(
    [
      'Generated changelog entries need a human review before release continues.',
      'Please edit these file(s) now if needed:',
      ...changelogPaths.map((changelogPath) => `  - ${changelogPath}`),
    ].join('\n'),
  );

  const { action } = await prompts(
    {
      type: 'select',
      name: 'action',
      message: 'Continue after changelog review?',
      choices: [
        {
          title: 'Continue release',
          value: 'continue',
        },
        {
          title: 'Abort release',
          value: 'abort',
        },
      ],
      initial: 0,
    },
    {
      onCancel() {
        throw new Error('Release cancelled after changelog review');
      },
    },
  );

  process.stdout.write('\n');

  if (action !== 'continue') {
    throw new Error('Release cancelled after changelog review');
  }
}

export function ensureFileExists(filePath: string, message: string): void {
  if (!existsSync(filePath)) {
    throw new Error(message);
  }
}

export function formatReleasePlans(plans: ReleasePlan[]): string {
  return plans
    .map((plan, index) => {
      const lines = [
        `${index + 1}. ${plan.config.packageName}`,
        `   version: ${plan.currentVersion} -> ${plan.newVersion}`,
        `   tag: ${plan.gitTag}`,
        `   npm tag: ${plan.npmTag || 'latest'}`,
        `   publish dir: ${path.relative(REPO_ROOT, plan.config.publishDir)}`,
        `   checks: ${plan.config.previewChecks.join(', ')}`,
      ];
      return lines.join('\n');
    })
    .join('\n');
}

export function getCommitUrl(commitHash: string): string {
  const mapping = readFileSync(
    path.join(REPO_ROOT, 'migration/commit-map'),
    'utf8',
  );
  const match = mapping
    .split('\n')
    .slice(1)
    .map((line) => line.split(/\s+/u))
    .find(([, rewritten]) => rewritten?.startsWith(commitHash));
  return match
    ? `https://github.com/senaoxi/docs-islands/commit/${match[0]}`
    : `${REPOSITORY_URL}/commit/${commitHash}`;
}
