import * as prompts from '@clack/prompts';
import { createElapsedTimer } from 'logaria/helper';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { glob } from 'tinyglobby';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';
import type { ResolvedLiminaConfig } from '../config';
import type { LiminaFlowReporter } from '../flow';
import { collectImportsFromFile, isRelativeSpecifier } from '../graph-context';
import { InitLogger, clearCliScreen, formatErrorMessage } from '../logger';
import {
  isOrdinaryTypecheckConfigPath,
  readJsonConfig,
  type JsonObject,
} from '../tsconfig';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  toPosixPath,
  toRelativePath,
} from '../utils/path';
import {
  collectWorkspacePackages,
  getDependencySections,
  getPackageRootSpecifier,
  isWorkspaceDependencySpecifier,
  readJsonFile,
  type PackageManifest,
  type WorkspacePackage,
} from '../workspace';

export interface RunInitOptions {
  clearScreen?: boolean;
  cwd?: string;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  yes?: boolean;
}

export interface RunInitResult {
  checkCommand: string;
  installRequired: boolean;
  rootDir: string;
  skippedFiles: string[];
  workspacePackageCount: number;
  writtenFiles: string[];
}

interface TypecheckProject {
  configPath: string;
  dtsConfigPath: string;
  fileNames: string[];
  options: ts.CompilerOptions;
  owner: WorkspacePackage | null;
  references: string[];
  scope: string;
}

interface ParsedTypeScriptConfig {
  fileNames: string[];
  options: ts.CompilerOptions;
}

interface InitPromptOptions {
  yes?: boolean;
}

interface LiminaPackageMetadata {
  typescriptRange: string;
  versionRange: string;
}

const pnpmWorkspaceFileName = 'pnpm-workspace.yaml';
const liminaConfigFileName = 'limina.config.mjs';
const liminaCheckScriptName = 'limina:check';
const liminaCheckScriptValue = 'limina check';
const ignoredGlobPatterns = [
  '**/.git/**',
  '**/.limina/**',
  '**/.pnpm-store/**',
  '**/.tsbuild/**',
  '**/coverage/**',
  '**/dist/**',
  '**/node_modules/**',
];

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

function formatReferencePath(
  fromConfigPath: string,
  toConfigPath: string,
): string {
  const relativePath = toPosixPath(
    path.relative(path.dirname(fromConfigPath), toConfigPath),
  );

  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
}

function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function getProjectScope(configPath: string): string {
  const fileName = path.basename(configPath);

  if (fileName === 'tsconfig.json') {
    return 'tsconfig';
  }

  const match = /^tsconfig\.(.+)\.json$/u.exec(fileName);

  return match?.[1] ?? 'tsconfig';
}

function getDtsConfigPath(configPath: string): string {
  const directory = path.dirname(configPath);
  const fileName = path.basename(configPath);
  const dtsFileName =
    fileName === 'tsconfig.json'
      ? 'tsconfig.dts.json'
      : fileName.replace(/\.json$/u, '.dts.json');

  return path.join(directory, dtsFileName);
}

function hasReferences(configObject: JsonObject): boolean {
  return (
    Array.isArray(configObject.references) && configObject.references.length > 0
  );
}

function parseTypeScriptConfig(
  rootDir: string,
  configPath: string,
): ParsedTypeScriptConfig {
  const diagnostics: ts.Diagnostic[] = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
    },
  );

  if (!parsed) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => rootDir,
        getNewLine: () => '\n',
      }),
    );
  }

  if (parsed.errors.length > 0) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => rootDir,
        getNewLine: () => '\n',
      }),
    );
  }

  return {
    fileNames: parsed.fileNames.map(normalizeAbsolutePath),
    options: parsed.options,
  };
}

function findNearestWorkspacePackage(
  filePath: string,
  packages: WorkspacePackage[],
): WorkspacePackage | null {
  return (
    [...packages]
      .sort((left, right) => right.directory.length - left.directory.length)
      .find((workspacePackage) =>
        isPathInsideDirectory(filePath, workspacePackage.directory),
      ) ?? null
  );
}

function collectWorkspaceDependencyNames(
  manifest: PackageManifest,
): Set<string> {
  const dependencyNames = new Set<string>();

  for (const dependencies of getDependencySections(manifest)) {
    for (const [dependencyName, specifier] of Object.entries(dependencies)) {
      if (isWorkspaceDependencySpecifier(specifier)) {
        dependencyNames.add(dependencyName);
      }
    }
  }

  return dependencyNames;
}

function findOwningProjectForFile(
  filePath: string,
  projects: TypecheckProject[],
): TypecheckProject | null {
  const normalizedFilePath = normalizeAbsolutePath(filePath);
  const owners = projects.filter((project) =>
    project.fileNames.includes(normalizedFilePath),
  );

  return (
    owners.sort((left, right) => {
      const depthDelta =
        path.dirname(right.configPath).length -
        path.dirname(left.configPath).length;

      return depthDelta === 0
        ? left.configPath.localeCompare(right.configPath)
        : depthDelta;
    })[0] ?? null
  );
}

function isDirectory(filePath: string): boolean {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function mapVirtualWorkspacePath(
  filePath: string,
  packageByName: Map<string, WorkspacePackage>,
): string | null {
  const normalizedPath = normalizeAbsolutePath(filePath);
  const segments = normalizedPath.split('/');

  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] !== 'node_modules') {
      continue;
    }

    const firstPackageSegment = segments[index + 1];

    if (!firstPackageSegment) {
      continue;
    }

    const isScopedPackage = firstPackageSegment.startsWith('@');
    const packageName = isScopedPackage
      ? `${firstPackageSegment}/${segments[index + 2] ?? ''}`
      : firstPackageSegment;
    const restStart = index + (isScopedPackage ? 3 : 2);
    const workspacePackage = packageByName.get(packageName);

    if (!workspacePackage) {
      continue;
    }

    return path.join(workspacePackage.directory, ...segments.slice(restStart));
  }

  return null;
}

function isVirtualWorkspaceDirectory(
  directoryPath: string,
  packageByName: Map<string, WorkspacePackage>,
): boolean {
  const normalizedPath = normalizeAbsolutePath(directoryPath);
  const segments = normalizedPath.split('/');

  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] !== 'node_modules') {
      continue;
    }

    const firstPackageSegment = segments[index + 1];

    if (!firstPackageSegment) {
      return packageByName.size > 0;
    }

    if (
      firstPackageSegment.startsWith('@') &&
      segments[index + 2] === undefined
    ) {
      return [...packageByName.keys()].some((packageName) =>
        packageName.startsWith(`${firstPackageSegment}/`),
      );
    }
  }

  const mappedPath = mapVirtualWorkspacePath(directoryPath, packageByName);

  return mappedPath ? isDirectory(mappedPath) : false;
}

function createWorkspaceModuleResolutionHost(options: {
  packageByName: Map<string, WorkspacePackage>;
  rootDir: string;
}): ts.ModuleResolutionHost {
  const mapPath = (filePath: string): string =>
    mapVirtualWorkspacePath(filePath, options.packageByName) ?? filePath;

  return {
    directoryExists: (directoryPath) =>
      isVirtualWorkspaceDirectory(directoryPath, options.packageByName) ||
      (ts.sys.directoryExists?.(directoryPath) ?? isDirectory(directoryPath)),
    fileExists: (filePath) => {
      const mappedPath = mapPath(filePath);

      return existsSync(mappedPath) && !isDirectory(mappedPath);
    },
    getCurrentDirectory: () => options.rootDir,
    readFile: (filePath) => ts.sys.readFile(mapPath(filePath)),
    realpath: (filePath) => normalizeAbsolutePath(mapPath(filePath)),
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
  };
}

function resolveImportWithTypeScript(options: {
  cache: ts.ModuleResolutionCache;
  host: ts.ModuleResolutionHost;
  importRecord: ReturnType<typeof collectImportsFromFile>[number];
  packageByName: Map<string, WorkspacePackage>;
  project: TypecheckProject;
}): string | null {
  const resolvedModule = ts.resolveModuleName(
    options.importRecord.specifier,
    options.importRecord.filePath,
    options.project.options,
    options.host,
    options.cache,
  ).resolvedModule;

  if (!resolvedModule?.resolvedFileName) {
    return null;
  }

  return normalizeAbsolutePath(
    mapVirtualWorkspacePath(
      resolvedModule.resolvedFileName,
      options.packageByName,
    ) ?? resolvedModule.resolvedFileName,
  );
}

function isPackageImportSpecifier(specifier: string): boolean {
  return specifier.startsWith('#');
}

function createDtsConfig(project: TypecheckProject): JsonObject {
  const fileName = path.basename(project.configPath);
  const scope = project.scope;
  const output: JsonObject = {
    $schema: 'https://json.schemastore.org/tsconfig',
    extends: [`./${fileName}`],
    compilerOptions: {
      composite: true,
      incremental: true,
      noEmit: false,
      declaration: true,
      emitDeclarationOnly: true,
      declarationMap: false,
      rootDir: '.',
      outDir: './.limina',
      tsBuildInfoFile: `./.limina/${scope}.tsbuildinfo`,
    },
  };

  if (project.references.length > 0) {
    output.references = project.references.map((referencePath) => ({
      path: referencePath,
    }));
  }

  return output;
}

function createBuildAggregator(references: string[]): JsonObject {
  return {
    $schema: 'https://json.schemastore.org/tsconfig',
    files: [],
    references: references.map((referencePath) => ({
      path: referencePath,
    })),
  };
}

function createLiminaConfigContent(): string {
  return `import { defineConfig } from 'limina';

export default defineConfig({
  // Shared checker entries used by graph, proof, paths, and typecheck checks.
  config: {
    checkers: {
      typescript: {
        preset: 'tsc',
        entry: 'tsconfig.build.json',
      },
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

async function writeBuildAggregatorFile(options: {
  configPath: string;
  references: string[];
  writtenFiles: string[];
}): Promise<boolean> {
  if (options.references.length === 0) {
    return false;
  }

  await writeTextFile(
    options.configPath,
    stringifyJson(createBuildAggregator(options.references)),
    options.writtenFiles,
  );

  return true;
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
}): Promise<boolean> {
  const packageJsonPath = path.join(options.rootDir, 'package.json');
  let installRequired = false;

  if (!existsSync(packageJsonPath)) {
    const shouldCreate = await confirmAction(
      options.prompt,
      `No package.json found at ${formatConfigPath(options.rootDir, packageJsonPath)}. Create one?`,
    );

    if (!shouldCreate) {
      options.skippedFiles.push(packageJsonPath);
      return false;
    }

    const manifest: PackageManifest = {
      private: true,
      type: 'module',
      scripts: {
        [liminaCheckScriptName]: liminaCheckScriptValue,
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

    return true;
  }

  const manifest = readJsonFile<PackageManifest>(packageJsonPath);
  const scripts = {
    ...(manifest.scripts ?? {}),
  };
  let changed = false;

  if (
    scripts[liminaCheckScriptName] &&
    scripts[liminaCheckScriptName] !== liminaCheckScriptValue
  ) {
    const shouldOverwrite = await confirmAction(
      options.prompt,
      `Script "${liminaCheckScriptName}" already exists in package.json. Overwrite it?`,
    );

    if (shouldOverwrite) {
      scripts[liminaCheckScriptName] = liminaCheckScriptValue;
      changed = true;
    }
  } else if (!scripts[liminaCheckScriptName]) {
    scripts[liminaCheckScriptName] = liminaCheckScriptValue;
    changed = true;
  }

  if (!hasDependency(manifest, 'limina')) {
    manifest.devDependencies = {
      ...(manifest.devDependencies ?? {}),
      limina: options.metadata.versionRange,
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
  }

  return installRequired;
}

async function collectReservedConfigConflicts(
  rootDir: string,
): Promise<string[]> {
  const conflicts = await glob(
    [
      'tsconfig*.build.json',
      '**/tsconfig*.build.json',
      'tsconfig*.dts.json',
      '**/tsconfig*.dts.json',
    ],
    {
      absolute: false,
      cwd: rootDir,
      ignore: ignoredGlobPatterns,
    },
  );

  return [...new Set(conflicts)].sort();
}

async function collectOrdinaryTsconfigPaths(
  rootDir: string,
): Promise<string[]> {
  const configPaths = await glob(['tsconfig*.json', '**/tsconfig*.json'], {
    absolute: false,
    cwd: rootDir,
    ignore: ignoredGlobPatterns,
  });

  return [...new Set(configPaths)]
    .map((configPath) => normalizeAbsolutePath(path.join(rootDir, configPath)))
    .filter(isOrdinaryTypecheckConfigPath)
    .sort();
}

function analyzeTypecheckProjects(options: {
  config: ResolvedLiminaConfig;
  configPaths: string[];
  workspacePackages: WorkspacePackage[];
}): { problems: string[]; projects: TypecheckProject[] } {
  const problems: string[] = [];
  const projects: TypecheckProject[] = [];

  for (const configPath of options.configPaths) {
    const configObject = readJsonConfig(options.config, configPath);
    const parsed = parseTypeScriptConfig(options.config.rootDir, configPath);
    const hasProjectReferences = hasReferences(configObject);
    const fileName = path.basename(configPath);

    if (
      fileName === 'tsconfig.json' &&
      hasProjectReferences &&
      parsed.fileNames.length > 0
    ) {
      problems.push(
        [
          'Invalid tsconfig role:',
          `  config: ${formatConfigPath(options.config.rootDir, configPath)}`,
          '  reason: tsconfig.json must be either a pure aggregator with files: [] and references, or a typecheck leaf with source files, but not both.',
        ].join('\n'),
      );
      continue;
    }

    if (fileName !== 'tsconfig.json' && hasProjectReferences) {
      problems.push(
        [
          'Invalid scoped tsconfig role:',
          `  config: ${formatConfigPath(options.config.rootDir, configPath)}`,
          '  reason: tsconfig.<scope>.json files may only be typecheck leaves; graph aggregation belongs in tsconfig*.build.json.',
        ].join('\n'),
      );
      continue;
    }

    if (fileName === 'tsconfig.json' && hasProjectReferences) {
      continue;
    }

    projects.push({
      configPath,
      dtsConfigPath: getDtsConfigPath(configPath),
      fileNames: parsed.fileNames,
      options: parsed.options,
      owner: findNearestWorkspacePackage(configPath, options.workspacePackages),
      references: [],
      scope: getProjectScope(configPath),
    });
  }

  return {
    problems,
    projects,
  };
}

function inferProjectReferences(options: {
  config: ResolvedLiminaConfig;
  projects: TypecheckProject[];
  workspacePackages: WorkspacePackage[];
}): string[] {
  const problems: string[] = [];
  const packageByName = new Map(
    options.workspacePackages.map((workspacePackage) => [
      workspacePackage.name,
      workspacePackage,
    ]),
  );
  const host = createWorkspaceModuleResolutionHost({
    packageByName,
    rootDir: options.config.rootDir,
  });

  for (const project of options.projects) {
    if (!project.owner) {
      continue;
    }

    const workspaceDependencyNames = collectWorkspaceDependencyNames(
      project.owner.manifest,
    );
    const resolutionCache = ts.createModuleResolutionCache(
      path.dirname(project.configPath),
      (fileName) => fileName,
      project.options,
    );
    const referencePaths = new Set<string>();

    for (const fileName of project.fileNames) {
      if (!/\.(?:[cm]?tsx?|d\.[cm]?ts)$/u.test(fileName)) {
        continue;
      }

      for (const importRecord of collectImportsFromFile(
        fileName,
        options.config.rootDir,
      )) {
        const resolvedFilePath = resolveImportWithTypeScript({
          cache: resolutionCache,
          host,
          importRecord,
          packageByName,
          project,
        });
        const isGraphInternalSpecifier =
          isRelativeSpecifier(importRecord.specifier) ||
          isPackageImportSpecifier(importRecord.specifier);
        const packageName = isGraphInternalSpecifier
          ? null
          : getPackageRootSpecifier(importRecord.specifier);
        const targetPackage = packageName
          ? packageByName.get(packageName)
          : null;
        const isWorkspaceGraphDependency =
          targetPackage &&
          (targetPackage.name === project.owner.name ||
            workspaceDependencyNames.has(targetPackage.name));

        if (
          packageName &&
          workspaceDependencyNames.has(packageName) &&
          !targetPackage
        ) {
          problems.push(
            [
              'Workspace dependency was not discovered by pnpm:',
              `  importing project: ${formatConfigPath(options.config.rootDir, project.dtsConfigPath)}`,
              `  file: ${formatConfigPath(options.config.rootDir, importRecord.filePath)}:${importRecord.line}`,
              `  imported specifier: ${importRecord.specifier}`,
              `  package: ${packageName}`,
              '  reason: package.json declares this dependency with the workspace: protocol, but limina init could not find a matching workspace package.',
            ].join('\n'),
          );
          continue;
        }

        if (targetPackage && !isWorkspaceGraphDependency) {
          continue;
        }

        if (!resolvedFilePath) {
          if (targetPackage && isWorkspaceGraphDependency) {
            problems.push(
              [
                'Unable to resolve workspace import with TypeScript:',
                `  importing project: ${formatConfigPath(options.config.rootDir, project.dtsConfigPath)}`,
                `  file: ${formatConfigPath(options.config.rootDir, importRecord.filePath)}:${importRecord.line}`,
                `  imported specifier: ${importRecord.specifier}`,
                `  package: ${targetPackage.name}`,
                '  reason: workspace:* imports must resolve with the project TypeScript compilerOptions before limina init can generate project references.',
              ].join('\n'),
            );
          }
          continue;
        }

        if (isRelativeSpecifier(importRecord.specifier)) {
          const sourcePackage = findNearestWorkspacePackage(
            importRecord.filePath,
            options.workspacePackages,
          );
          const resolvedPackage = findNearestWorkspacePackage(
            resolvedFilePath,
            options.workspacePackages,
          );

          if (
            sourcePackage &&
            resolvedPackage &&
            sourcePackage.name !== resolvedPackage.name
          ) {
            continue;
          }
        }

        const targetProject = findOwningProjectForFile(
          resolvedFilePath,
          options.projects,
        );

        if (!targetProject) {
          if (targetPackage && isWorkspaceGraphDependency) {
            problems.push(
              [
                'Unable to map workspace import to a generated declaration leaf:',
                `  importing project: ${formatConfigPath(options.config.rootDir, project.dtsConfigPath)}`,
                `  file: ${formatConfigPath(options.config.rootDir, importRecord.filePath)}:${importRecord.line}`,
                `  imported specifier: ${importRecord.specifier}`,
                `  resolved file: ${formatConfigPath(options.config.rootDir, resolvedFilePath)}`,
                '  reason: TypeScript resolved this workspace import, but the resolved module is not covered by any ordinary tsconfig*.json leaf.',
              ].join('\n'),
            );
          }
          continue;
        }

        if (targetProject.dtsConfigPath !== project.dtsConfigPath) {
          referencePaths.add(
            formatReferencePath(
              project.dtsConfigPath,
              targetProject.dtsConfigPath,
            ),
          );
        }
      }
    }

    project.references = [...referencePaths].sort();
  }

  return problems;
}

function collectProjectReferencesForOwner(options: {
  owner: WorkspacePackage | null;
  projects: TypecheckProject[];
  targetConfigPath: string;
}): string[] {
  return options.projects
    .filter((project) => project.owner?.directory === options.owner?.directory)
    .map((project) =>
      formatReferencePath(options.targetConfigPath, project.dtsConfigPath),
    )
    .sort();
}

function collectRootBuildProjectReferences(options: {
  projects: TypecheckProject[];
  rootDir: string;
  targetConfigPath: string;
}): string[] {
  return options.projects
    .filter(
      (project) =>
        !project.owner ||
        project.owner.directory === options.rootDir ||
        path.dirname(project.configPath) === options.rootDir,
    )
    .map((project) =>
      formatReferencePath(options.targetConfigPath, project.dtsConfigPath),
    )
    .sort();
}

async function writeGeneratedTsconfigs(options: {
  projects: TypecheckProject[];
  rootDir: string;
  writtenFiles: string[];
  workspacePackages: WorkspacePackage[];
}): Promise<void> {
  for (const project of options.projects) {
    await writeTextFile(
      project.dtsConfigPath,
      stringifyJson(createDtsConfig(project)),
      options.writtenFiles,
    );
  }

  const nonRootWorkspacePackages = options.workspacePackages.filter(
    (workspacePackage) => workspacePackage.directory !== options.rootDir,
  );
  const workspaceBuildConfigPaths: string[] = [];

  for (const workspacePackage of nonRootWorkspacePackages) {
    const buildConfigPath = path.join(
      workspacePackage.directory,
      'tsconfig.build.json',
    );
    const references = collectProjectReferencesForOwner({
      owner: workspacePackage,
      projects: options.projects,
      targetConfigPath: buildConfigPath,
    });

    if (
      await writeBuildAggregatorFile({
        configPath: buildConfigPath,
        references,
        writtenFiles: options.writtenFiles,
      })
    ) {
      workspaceBuildConfigPaths.push(buildConfigPath);
    }
  }

  const rootBuildConfigPath = path.join(options.rootDir, 'tsconfig.build.json');
  const rootReferences = [
    ...collectRootBuildProjectReferences({
      projects: options.projects,
      rootDir: options.rootDir,
      targetConfigPath: rootBuildConfigPath,
    }),
    ...workspaceBuildConfigPaths.map((buildConfigPath) =>
      formatReferencePath(rootBuildConfigPath, buildConfigPath),
    ),
  ].sort();

  await writeBuildAggregatorFile({
    configPath: rootBuildConfigPath,
    references: rootReferences,
    writtenFiles: options.writtenFiles,
  });
}

async function writeLiminaConfig(options: {
  prompt: InitPromptOptions;
  rootDir: string;
  skippedFiles: string[];
  writtenFiles: string[];
}): Promise<void> {
  const configPath = path.join(options.rootDir, liminaConfigFileName);

  if (existsSync(configPath)) {
    const shouldOverwrite = await confirmAction(
      options.prompt,
      `${liminaConfigFileName} already exists. Overwrite it?`,
    );

    if (!shouldOverwrite) {
      options.skippedFiles.push(configPath);
      return;
    }
  }

  await writeTextFile(
    configPath,
    createLiminaConfigContent(),
    options.writtenFiles,
  );
}

async function runInitInternal(
  options: RunInitOptions,
): Promise<RunInitResult> {
  const cwd = normalizeAbsolutePath(options.cwd ?? process.cwd());
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

  const reservedConflicts = await collectReservedConfigConflicts(rootDir);

  if (reservedConflicts.length > 0) {
    throw new Error(
      [
        'Unable to run limina init because reserved Limina tsconfig names already exist:',
        ...reservedConflicts.map((configPath) => `  - ${configPath}`),
        'reason: tsconfig*.build.json and tsconfig*.dts.json are Limina init output names; rename existing files before running init.',
      ].join('\n'),
    );
  }

  const config = createInitConfig(rootDir);
  const workspacePackages = (await collectWorkspacePackages(config)).filter(
    (workspacePackage) => workspacePackage.directory !== rootDir,
  );
  const configPaths = await collectOrdinaryTsconfigPaths(rootDir);
  const projectAnalysis = analyzeTypecheckProjects({
    config,
    configPaths,
    workspacePackages,
  });
  const problems = [...projectAnalysis.problems];

  if (problems.length === 0) {
    problems.push(
      ...inferProjectReferences({
        config,
        projects: projectAnalysis.projects,
        workspacePackages,
      }),
    );
  }

  if (problems.length > 0) {
    throw new Error(problems.join('\n\n'));
  }

  const metadata = readLiminaPackageMetadata();
  const writtenFiles: string[] = [];
  const skippedFiles: string[] = [];

  await writeGeneratedTsconfigs({
    projects: projectAnalysis.projects,
    rootDir,
    workspacePackages,
    writtenFiles,
  });
  await writeLiminaConfig({
    prompt: options,
    rootDir,
    skippedFiles,
    writtenFiles,
  });
  const installRequired = await updateRootPackageJson({
    metadata,
    prompt: options,
    rootDir,
    skippedFiles,
    writtenFiles,
  });

  return {
    checkCommand: 'pnpm limina:check',
    installRequired,
    rootDir,
    skippedFiles,
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
    depth: options.flowDepth ?? 0,
  });

  InitLogger.info('init started');

  try {
    const result = await runInitInternal(options);

    InitLogger.success(
      `init generated ${result.writtenFiles.length} files for ${result.workspacePackageCount} workspace packages.`,
      elapsed(),
    );

    if (result.installRequired) {
      InitLogger.info(
        'limina was added to devDependencies; run pnpm i before checking.',
      );
    }

    InitLogger.info(
      `next: ${result.installRequired ? 'pnpm i && ' : ''}${result.checkCommand}`,
    );
    task?.pass();

    return result;
  } catch (error) {
    InitLogger.error(`init failed: ${formatErrorMessage(error)}`, elapsed());
    task?.fail('init failed', { error });
    throw error;
  }
}
