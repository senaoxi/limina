import type { JSONReport } from 'knip';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ResolvedLiminaConfig } from './config';
import { normalizeAbsolutePath, toRelativePath } from './utils/path';
import type { WorkspacePackage } from './workspace';

export interface KnipUnusedWorkspaceDependencyIssue {
  dependencyName: string;
  packageJsonPath: string;
}

export interface KnipUnusedSourceFileIssue {
  filePath: string;
}

export interface KnipOwnerProject {
  directory: string;
  entryFiles: string[];
  ignoreFiles: string[];
  projectFiles: string[];
  virtualEntrySourceFiles: string[];
}

export interface KnipSourceIssues {
  unusedSourceFiles: KnipUnusedSourceFileIssue[];
  unusedWorkspaceDependencies: KnipUnusedWorkspaceDependencyIssue[];
}

interface KnipJsonDependencyItem {
  name: string;
}

interface KnipWorkspaceConfig {
  entry?: string[];
  ignoreDependencies?: string[];
  ignoreFiles?: string[];
  project?: string[];
}

interface KnipConfig extends KnipWorkspaceConfig {
  $schema: string;
  workspaces?: Record<string, KnipWorkspaceConfig>;
}

const requireFromLimina = createRequire(import.meta.url);
const knipJsonIssueFields = [
  'dependencies',
  'devDependencies',
  'optionalPeerDependencies',
] as const;
const knipSourceIssueTypes = ['dependencies', 'files'] as const;

type KnipSourceIssueType = (typeof knipSourceIssueTypes)[number];

function resolveKnipCliPath(): string {
  try {
    const knipEntryPath = requireFromLimina.resolve('knip');

    return normalizeAbsolutePath(
      path.resolve(path.dirname(knipEntryPath), '../bin/knip.js'),
    );
  } catch (error) {
    throw new Error(
      [
        'Failed to resolve the Knip CLI required by Limina source dependency checks.',
        '  reason: Knip is a Limina runtime dependency and must be installed with the workspace dependencies.',
        '  fix: reinstall dependencies, for example with `pnpm install`.',
        `  error: ${error instanceof Error ? error.message : String(error)}`,
      ].join('\n'),
    );
  }
}

function runKnipCli(options: {
  configPath: string;
  include: KnipSourceIssueType[];
  rootDir: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      resolveKnipCliPath(),
      '--directory',
      options.rootDir,
      '--config',
      options.configPath,
      ...options.include.flatMap((issueType) => ['--include', issueType]),
      '--reporter',
      'json',
      '--no-exit-code',
      '--no-progress',
      '--no-config-hints',
    ];

    execFile(
      process.execPath,
      args,
      {
        cwd: options.rootDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          NO_COLOR: '1',
        },
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              [
                'Knip source analysis failed.',
                '  reason: Limina delegates unused source dependency and module detection to Knip.',
                `  command: ${process.execPath} ${args.join(' ')}`,
                stderr.trim() ? `  stderr:\n${stderr.trim()}` : '',
                `  error: ${error.message}`,
              ]
                .filter(Boolean)
                .join('\n'),
            ),
          );
          return;
        }

        resolve(stdout);
      },
    );
  });
}

function findJsonObjectEnd(source: string, start: number): number | undefined {
  let depth = 0;
  let escaped = false;
  let inString = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }

      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === '{') {
      depth += 1;
      continue;
    }

    if (character === '}') {
      depth -= 1;

      if (depth === 0) {
        return index + 1;
      }

      if (depth < 0) {
        return undefined;
      }
    }
  }

  return undefined;
}

function assertKnipJsonReport(value: unknown): JSONReport {
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray((value as JSONReport).issues)
  ) {
    throw new Error('JSON report must be an object with an issues array.');
  }

  return value as JSONReport;
}

function tryParseKnipJsonReport(source: string): JSONReport | undefined {
  try {
    return assertKnipJsonReport(JSON.parse(source) as unknown);
  } catch {
    return undefined;
  }
}

export function parseKnipJsonReport(source: string): JSONReport {
  const trimmed = source.trim();

  if (trimmed.length === 0) {
    return {
      issues: [],
    };
  }

  const parsedReport = tryParseKnipJsonReport(trimmed);

  if (parsedReport) {
    return parsedReport;
  }

  const reportStartPattern = /\{\s*"issues"\s*:/gu;

  for (const match of trimmed.matchAll(reportStartPattern)) {
    const start = match.index ?? 0;
    const end = findJsonObjectEnd(trimmed, start);

    if (end === undefined) {
      continue;
    }

    const embeddedReport = tryParseKnipJsonReport(trimmed.slice(start, end));

    if (embeddedReport) {
      return embeddedReport;
    }
  }

  try {
    return assertKnipJsonReport(JSON.parse(trimmed) as unknown);
  } catch (error) {
    throw new Error(
      [
        'Failed to parse Knip JSON report.',
        `  reason: Limina expects Knip's json reporter to write a JSON object with an issues array.`,
        `  error: ${error instanceof Error ? error.message : String(error)}`,
        '  output:',
        trimmed.slice(0, 2000),
      ].join('\n'),
    );
  }
}

function createIgnoredDependenciesByWorkspace(options: {
  ignoredKeys: Set<string>;
  rootDir: string;
  workspacePackages: WorkspacePackage[];
}): Record<string, KnipWorkspaceConfig> {
  const ignoredByWorkspace: Record<string, KnipWorkspaceConfig> = {};

  for (const workspacePackage of options.workspacePackages) {
    const dependencies = [...options.ignoredKeys]
      .flatMap((dependencyKey) => {
        const [importerName, dependencyName] = dependencyKey.split('\0');

        return importerName === workspacePackage.name && dependencyName
          ? [dependencyName]
          : [];
      })
      .sort();

    if (dependencies.length === 0) {
      continue;
    }

    ignoredByWorkspace[
      toRelativePath(options.rootDir, workspacePackage.directory)
    ] = {
      ignoreDependencies: dependencies,
    };
  }

  return ignoredByWorkspace;
}

function getKnipWorkspaceConfig(options: {
  directory: string;
  knipConfig: KnipConfig;
  rootDir: string;
}): KnipWorkspaceConfig {
  const directory = normalizeAbsolutePath(options.directory);
  const rootDir = normalizeAbsolutePath(options.rootDir);

  if (directory === rootDir) {
    return options.knipConfig;
  }

  const workspaceKey = toRelativePath(rootDir, directory);
  options.knipConfig.workspaces ??= {};
  options.knipConfig.workspaces[workspaceKey] ??= {};

  return options.knipConfig.workspaces[workspaceKey];
}

function addOwnerProjectsToKnipConfig(options: {
  knipConfig: KnipConfig;
  ownerProjects: KnipOwnerProject[];
  rootDir: string;
}): void {
  for (const ownerProject of options.ownerProjects) {
    const workspaceConfig = getKnipWorkspaceConfig({
      directory: ownerProject.directory,
      knipConfig: options.knipConfig,
      rootDir: options.rootDir,
    });

    if (ownerProject.projectFiles.length > 0) {
      workspaceConfig.project = ownerProject.projectFiles;
    }

    if (ownerProject.entryFiles.length > 0) {
      workspaceConfig.entry = ownerProject.entryFiles;
    }

    if (ownerProject.ignoreFiles.length > 0) {
      workspaceConfig.ignoreFiles = ownerProject.ignoreFiles;
    }
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function createVirtualEntryContent(
  sourceFiles: string[],
  entryDir: string,
): string {
  const imports = sourceFiles
    .map((sourceFile) => {
      const relativePath = toRelativePath(entryDir, sourceFile);
      const specifier = relativePath.startsWith('.')
        ? relativePath
        : `./${relativePath}`;

      return `import ${JSON.stringify(specifier)};`;
    })
    .sort();

  return [
    '// Generated temporarily by Limina for Knip source analysis.',
    ...imports,
    '',
  ].join('\n');
}

async function withTemporaryVirtualEntries<T>(
  ownerProjects: KnipOwnerProject[],
  run: (ownerProjects: KnipOwnerProject[]) => Promise<T>,
): Promise<T> {
  const createdParentDirectories = new Set<string>();
  const tempDirectories: string[] = [];

  try {
    const ownerProjectsWithVirtualEntries = await Promise.all(
      ownerProjects.map(async (ownerProject) => {
        if (ownerProject.virtualEntrySourceFiles.length === 0) {
          return ownerProject;
        }

        const tempParentDirectory = path.join(
          ownerProject.directory,
          '.tsbuild',
        );
        const parentAlreadyExists = await pathExists(tempParentDirectory);

        await mkdir(tempParentDirectory, {
          recursive: true,
        });

        if (!parentAlreadyExists) {
          createdParentDirectories.add(tempParentDirectory);
        }

        const tempDirectory = await mkdtemp(
          path.join(tempParentDirectory, 'limina-knip-'),
        );
        const virtualEntryPath = path.join(tempDirectory, 'entry.ts');

        tempDirectories.push(tempDirectory);

        await writeFile(
          virtualEntryPath,
          createVirtualEntryContent(
            ownerProject.virtualEntrySourceFiles,
            tempDirectory,
          ),
        );

        return {
          ...ownerProject,
          entryFiles: [
            ...ownerProject.entryFiles,
            toRelativePath(ownerProject.directory, virtualEntryPath),
          ].sort(),
        };
      }),
    );

    return await run(ownerProjectsWithVirtualEntries);
  } finally {
    await Promise.all(
      tempDirectories.map((tempDirectory) =>
        rm(tempDirectory, {
          force: true,
          recursive: true,
        }),
      ),
    );
    await Promise.all(
      [...createdParentDirectories].map(async (directory) => {
        try {
          await rmdir(directory);
        } catch (error) {
          const errorCode = (error as { code?: string }).code;

          if (errorCode !== 'ENOTEMPTY' && errorCode !== 'ENOENT') {
            throw error;
          }
        }
      }),
    );
  }
}

async function withTemporaryKnipConfig<T>(
  config: KnipConfig,
  run: (configPath: string) => Promise<T>,
): Promise<T> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'limina-knip-'));
  const configPath = path.join(tempDir, 'knip.json');

  try {
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    return await run(configPath);
  } finally {
    await rm(tempDir, {
      force: true,
      recursive: true,
    });
  }
}

export function collectUnusedWorkspaceDependencyIssues(options: {
  report: JSONReport;
  rootDir: string;
  workspacePackageNames: Set<string>;
}): KnipUnusedWorkspaceDependencyIssue[] {
  const issues: KnipUnusedWorkspaceDependencyIssue[] = [];

  for (const entry of options.report.issues) {
    const file = entry.file;

    if (typeof file !== 'string' || !file.endsWith('package.json')) {
      continue;
    }

    const packageJsonPath = normalizeAbsolutePath(
      path.isAbsolute(file) ? file : path.join(options.rootDir, file),
    );

    for (const field of knipJsonIssueFields) {
      const dependencies = entry[field] as KnipJsonDependencyItem[] | undefined;

      if (!Array.isArray(dependencies)) {
        continue;
      }

      for (const dependency of dependencies) {
        if (
          typeof dependency.name !== 'string' ||
          !options.workspacePackageNames.has(dependency.name)
        ) {
          continue;
        }

        issues.push({
          dependencyName: dependency.name,
          packageJsonPath,
        });
      }
    }
  }

  return issues.sort((left, right) => {
    if (left.packageJsonPath !== right.packageJsonPath) {
      return left.packageJsonPath.localeCompare(right.packageJsonPath);
    }

    return left.dependencyName.localeCompare(right.dependencyName);
  });
}

function toAbsoluteIssuePath(rootDir: string, filePath: string): string {
  return normalizeAbsolutePath(
    path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath),
  );
}

export function collectUnusedSourceFileIssues(options: {
  report: JSONReport;
  rootDir: string;
}): KnipUnusedSourceFileIssue[] {
  const filePaths = new Set<string>();

  for (const entry of options.report.issues) {
    const files = entry.files;

    if (Array.isArray(files) && files.length > 0) {
      for (const file of files) {
        if (typeof file.name !== 'string' || file.name.trim().length === 0) {
          continue;
        }

        filePaths.add(toAbsoluteIssuePath(options.rootDir, file.name));
      }

      continue;
    }

    if (typeof entry.file !== 'string' || entry.file.endsWith('package.json')) {
      continue;
    }

    filePaths.add(toAbsoluteIssuePath(options.rootDir, entry.file));
  }

  return [...filePaths]
    .sort((left, right) => left.localeCompare(right))
    .map((filePath) => ({
      filePath,
    }));
}

export async function collectKnipSourceIssues(options: {
  config: ResolvedLiminaConfig;
  ignoredKeys: Set<string>;
  includeFiles: boolean;
  ownerProjects: KnipOwnerProject[];
  workspacePackages: WorkspacePackage[];
}): Promise<KnipSourceIssues> {
  const knipConfig: KnipConfig = {
    $schema: 'https://unpkg.com/knip@6/schema.json',
  };
  const workspaces = createIgnoredDependenciesByWorkspace({
    ignoredKeys: options.ignoredKeys,
    rootDir: options.config.rootDir,
    workspacePackages: options.workspacePackages,
  });

  if (Object.keys(workspaces).length > 0) {
    knipConfig.workspaces = workspaces;
  }

  const include: KnipSourceIssueType[] = options.includeFiles
    ? ['dependencies', 'files']
    : ['dependencies'];
  const report = await withTemporaryVirtualEntries(
    options.ownerProjects,
    async (ownerProjects) => {
      addOwnerProjectsToKnipConfig({
        knipConfig,
        ownerProjects,
        rootDir: options.config.rootDir,
      });

      return await withTemporaryKnipConfig(knipConfig, async (configPath) =>
        parseKnipJsonReport(
          await runKnipCli({
            configPath,
            include,
            rootDir: options.config.rootDir,
          }),
        ),
      );
    },
  );

  const workspacePackageNames = new Set(
    options.workspacePackages.map((workspacePackage) => workspacePackage.name),
  );

  return {
    unusedSourceFiles: options.includeFiles
      ? collectUnusedSourceFileIssues({
          report,
          rootDir: options.config.rootDir,
        })
      : [],
    unusedWorkspaceDependencies: collectUnusedWorkspaceDependencyIssues({
      report,
      rootDir: options.config.rootDir,
      workspacePackageNames,
    }),
  };
}

export async function collectKnipUnusedWorkspaceDependencyIssues(options: {
  config: ResolvedLiminaConfig;
  ignoredKeys: Set<string>;
  workspacePackages: WorkspacePackage[];
}): Promise<KnipUnusedWorkspaceDependencyIssue[]> {
  return (
    await collectKnipSourceIssues({
      config: options.config,
      ignoredKeys: options.ignoredKeys,
      includeFiles: false,
      ownerProjects: [],
      workspacePackages: options.workspacePackages,
    })
  ).unusedWorkspaceDependencies;
}
