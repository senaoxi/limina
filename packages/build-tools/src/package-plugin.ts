import type { Catalogs } from '@pnpm/catalogs.types';
import { createExportableManifest } from '@pnpm/exportable-manifest';
import {
  readWorkspaceManifest,
  type WorkspaceManifest,
} from '@pnpm/workspace.read-manifest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { escapePath, glob, isDynamicPattern } from 'tinyglobby';
import { findMonorepoRoot } from './path.js';

export type DependencyMap = Record<string, string>;
export type CatalogMap = Record<string, DependencyMap>;
export type ExportValue = string | Record<string, unknown>;
export type PackageJsonObject = Record<string, unknown> & {
  dependencies?: DependencyMap;
  devDependencies?: DependencyMap;
  exports?: Record<string, ExportValue>;
  files?: string[];
  imports?: Record<string, string>;
  optionalDependencies?: DependencyMap;
  peerDependencies?: DependencyMap;
  types?: string;
};
export type DependencyFieldName =
  | 'dependencies'
  | 'devDependencies'
  | 'optionalDependencies'
  | 'peerDependencies';

export interface DependencyResolutionOptions {
  allowInternal?: boolean;
  dropPrivateWorkspaceDependencies?: boolean;
  dropWorkspaceDependencies?: boolean;
  dropUnsupportedProtocols?: boolean;
  internalScopes?: readonly string[];
}

export interface PackageJsonPluginContext {
  packageRootDir: string;
  workspaceConfigPath: string;
  resolvePublishedVersionRange: (
    packageName: string,
    versionRange: string,
  ) => string;
  sanitizeDependencyMap: (
    dependencies: DependencyMap | undefined,
    options?: DependencyResolutionOptions,
  ) => DependencyMap | undefined;
}

export interface ExportPathRewriteArguments {
  condition?: string;
  context: PackageJsonPluginContext;
  key: string;
  value: string;
}

export interface PackageExportsRewriteArguments {
  context: PackageJsonPluginContext;
  exportsField: Record<string, unknown> | undefined;
  rewriteExportPath: (arguments_: ExportPathRewriteArguments) => string;
}

export type PackageExportsRewriter = (
  arguments_: PackageExportsRewriteArguments,
) => Record<string, ExportValue> | undefined;

export interface EmittedPackageAsset {
  fileName: string;
  sourcePath: string;
  transform?: (source: string) => string;
}

export interface CreatePackagePluginOptions {
  dependencyFields?: Partial<
    Record<DependencyFieldName, DependencyResolutionOptions | false>
  >;
  emitAssets?: readonly EmittedPackageAsset[];
  exports?: PackageExportsRewriter | false;
  packageJsonPath: string;
  pluginName?: string;
  rewriteTypes?: boolean;
  transformPackageJson?: (
    packageJson: PackageJsonObject,
    context: PackageJsonPluginContext,
  ) => void;
}

export interface EmittedAssetFile {
  fileName: string;
  source: string | Uint8Array;
  type: 'asset';
}

export interface PackagePluginContextLike {
  emitFile(asset: EmittedAssetFile): unknown;
}

export interface PackagePluginLike {
  generateBundle: {
    handler(
      this: PackagePluginContextLike,
      outputOptions: OutputOptionsLike | undefined,
    ): Promise<void>;
    order: 'post';
  };
  name: string;
}

const NON_PUBLISHABLE_VERSION_PROTOCOL_PREFIXES = [
  'link:',
  'file:',
  'portal:',
  'patch:',
] as const;
const INTERNAL_SCOPES = ['@limina/'] as const;
const DEFAULT_REMOVE_FIELDS = [
  'scripts',
  'files',
  'imports',
  'packageManager',
] as const;
const DEFAULT_OUTPUT_DIR = 'dist';
const DEFAULT_PACKAGE_FILE_IGNORE_PATTERNS = [
  '**/.git/**',
  '**/node_modules/**',
] as const;
const DEFAULT_DEPENDENCY_FIELDS = {
  dependencies: {},
  devDependencies: {
    dropPrivateWorkspaceDependencies: true,
  },
  optionalDependencies: {},
  peerDependencies: {},
} as const satisfies Partial<
  Record<DependencyFieldName, DependencyResolutionOptions | false>
>;
const DEPENDENCY_FIELD_NAMES = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const satisfies readonly DependencyFieldName[];

type PnpmProjectManifest = Parameters<typeof createExportableManifest>[1];

interface PackageFilesEntry {
  isNegated: boolean;
  path: string;
}

interface PnpmExportablePackageJsonResult {
  packageJson: PackageJsonObject;
  privateWorkspacePackageNames: ReadonlySet<string>;
}

interface WorkspacePackageManifest {
  name?: unknown;
  private?: unknown;
}

interface OutputOptionsLike {
  dir?: string;
  file?: string;
}

const GENERATED_ASSET_FILE_NAMES = new Set(['package.json']);

function toPosixPath(value: string): string {
  return value.replaceAll('\\', '/');
}

function isSubPath(ancestorDirectory: string, targetPath: string): boolean {
  const relativePath = path.relative(ancestorDirectory, targetPath);
  return (
    relativePath !== '' &&
    !relativePath.startsWith('..') &&
    !path.isAbsolute(relativePath)
  );
}

function normalizePackageFilesEntry(
  entry: string,
): PackageFilesEntry | undefined {
  const trimmedEntry = entry.trim();
  if (!trimmedEntry) {
    return undefined;
  }

  const isNegated = trimmedEntry.startsWith('!');
  const rawPath = isNegated ? trimmedEntry.slice(1).trim() : trimmedEntry;
  if (!rawPath) {
    return undefined;
  }

  const posixPath = toPosixPath(rawPath);
  if (path.isAbsolute(rawPath) || path.posix.isAbsolute(posixPath)) {
    throw new Error(
      `Absolute paths are not supported in package files entries: ${entry}`,
    );
  }

  const normalizedPath = path.posix.normalize(posixPath);
  if (normalizedPath === '..' || normalizedPath.startsWith('../')) {
    throw new Error(
      `Parent paths are not supported in package files entries: ${entry}`,
    );
  }

  return {
    isNegated,
    path: normalizedPath === '.' ? '**' : normalizedPath,
  };
}

function createPackageFilesGlobPattern(relativePath: string): string {
  if (relativePath === '**') {
    return relativePath;
  }

  return isDynamicPattern(relativePath, { caseSensitiveMatch: true })
    ? relativePath
    : escapePath(relativePath);
}

function resolveOutputDirectory(
  packageRootDirectory: string,
  outputOptions: OutputOptionsLike | undefined,
): string {
  const outputPath =
    outputOptions?.dir ??
    (outputOptions?.file
      ? path.dirname(outputOptions.file)
      : DEFAULT_OUTPUT_DIR);

  return path.resolve(packageRootDirectory, outputPath);
}

function createOutputDirectoryIgnorePatterns(
  packageRootDirectory: string,
  outputOptions: OutputOptionsLike | undefined,
): string[] {
  const outputDirectory = resolveOutputDirectory(
    packageRootDirectory,
    outputOptions,
  );

  if (!isSubPath(packageRootDirectory, outputDirectory)) {
    return [];
  }

  const relativeOutputDirectory = toPosixPath(
    path.relative(packageRootDirectory, outputDirectory),
  );
  const escapedOutputDirectory = escapePath(relativeOutputDirectory);
  return [escapedOutputDirectory, `${escapedOutputDirectory}/**`];
}

async function collectPackageFiles(
  packageRootDirectory: string,
  files: readonly string[] | undefined,
  outputOptions: OutputOptionsLike | undefined,
): Promise<EmittedPackageAsset[]> {
  if (!files || files.length === 0) {
    return [];
  }

  const includePatterns: string[] = [];
  const ignorePatterns = new Set<string>([
    ...DEFAULT_PACKAGE_FILE_IGNORE_PATTERNS,
    ...createOutputDirectoryIgnorePatterns(packageRootDirectory, outputOptions),
  ]);

  for (const entry of files) {
    if (typeof entry !== 'string') {
      continue;
    }

    const normalizedEntry = normalizePackageFilesEntry(entry);
    if (!normalizedEntry) {
      continue;
    }

    const globPattern = createPackageFilesGlobPattern(normalizedEntry.path);
    if (normalizedEntry.isNegated) {
      ignorePatterns.add(globPattern);
      ignorePatterns.add(`${globPattern}/**`);
    } else {
      includePatterns.push(globPattern);
    }
  }

  if (includePatterns.length === 0) {
    return [];
  }

  const fileNames = await glob(includePatterns, {
    absolute: false,
    cwd: packageRootDirectory,
    dot: true,
    expandDirectories: true,
    followSymbolicLinks: false,
    ignore: [...ignorePatterns],
    onlyFiles: true,
  });

  const normalizedFileNames = [
    ...new Set(fileNames.map((fileName) => toPosixPath(fileName))),
  ];

  normalizedFileNames.sort(
    (left, right) => Number(left > right) - Number(left < right),
  );

  return normalizedFileNames.map((fileName) => ({
    fileName,
    sourcePath: path.join(packageRootDirectory, fileName),
  }));
}

function createDependencyResolutionKey(
  packageName: string,
  versionRange: string,
): string {
  return `${packageName}\0${versionRange}`;
}

function createWorkspaceCatalogs(
  workspaceManifest: WorkspaceManifest | undefined,
): Catalogs {
  const catalogs: CatalogMap = {};

  if (workspaceManifest?.catalog) {
    catalogs.default = { ...workspaceManifest.catalog };
  }

  const workspaceCatalogs = Object.entries(workspaceManifest?.catalogs ?? {});
  for (const [catalogName, catalog] of workspaceCatalogs) {
    catalogs[catalogName] = { ...catalog };
  }

  return catalogs as Catalogs;
}

async function collectPrivateWorkspacePackageNames(
  workspaceRootDirectory: string,
  workspaceManifest: WorkspaceManifest | undefined,
): Promise<ReadonlySet<string>> {
  const workspacePackageDirectories = workspaceManifest?.packages.length
    ? await glob(workspaceManifest.packages, {
        absolute: false,
        cwd: workspaceRootDirectory,
        dot: true,
        expandDirectories: false,
        followSymbolicLinks: false,
        onlyDirectories: true,
      })
    : [];
  workspacePackageDirectories.push('.');

  const privateWorkspacePackageNames = new Set<string>();
  const uniqueWorkspacePackageDirectories = new Set(
    workspacePackageDirectories,
  );
  for (const workspacePackageDirectory of uniqueWorkspacePackageDirectories) {
    const packageJsonPath = path.join(
      workspaceRootDirectory,
      workspacePackageDirectory,
      'package.json',
    );
    if (!existsSync(packageJsonPath)) {
      continue;
    }

    const workspacePackageManifest = JSON.parse(
      readFileSync(packageJsonPath, 'utf8'),
    ) as WorkspacePackageManifest;
    if (
      typeof workspacePackageManifest.name === 'string' &&
      workspacePackageManifest.private === true
    ) {
      privateWorkspacePackageNames.add(workspacePackageManifest.name);
    }
  }

  return privateWorkspacePackageNames;
}

function isPrivateWorkspaceDependency(
  packageName: string,
  versionRange: string,
  privateWorkspacePackageNames: ReadonlySet<string>,
): boolean {
  return (
    versionRange.startsWith('workspace:') &&
    privateWorkspacePackageNames.has(packageName)
  );
}

function filterDependencyMapForPnpmExport(
  dependencies: DependencyMap | undefined,
  options: DependencyResolutionOptions,
  privateWorkspacePackageNames: ReadonlySet<string>,
): DependencyMap | undefined {
  if (!dependencies || typeof dependencies !== 'object') {
    return undefined;
  }

  const {
    allowInternal = true,
    dropPrivateWorkspaceDependencies = false,
    dropWorkspaceDependencies = false,
    internalScopes = INTERNAL_SCOPES,
  } = options;
  if (
    allowInternal &&
    !dropPrivateWorkspaceDependencies &&
    !dropWorkspaceDependencies
  ) {
    return dependencies;
  }

  const resolvedEntries = Object.entries(dependencies).filter(
    ([packageName, versionRange]) =>
      (allowInternal ||
        internalScopes.every((scope) => !packageName.startsWith(scope))) &&
      (!dropWorkspaceDependencies || !versionRange.startsWith('workspace:')) &&
      (!dropPrivateWorkspaceDependencies ||
        !isPrivateWorkspaceDependency(
          packageName,
          versionRange,
          privateWorkspacePackageNames,
        )),
  );

  return resolvedEntries.length === 0
    ? undefined
    : Object.fromEntries(resolvedEntries);
}

function createPnpmExportInputPackageJson(
  packageJson: PackageJsonObject,
  dependencyFields: Partial<
    Record<DependencyFieldName, DependencyResolutionOptions | false>
  >,
  privateWorkspacePackageNames: ReadonlySet<string>,
): PackageJsonObject {
  const pnpmExportInputPackageJson: PackageJsonObject = {
    ...packageJson,
  };

  for (const [fieldName, options] of Object.entries(dependencyFields) as [
    DependencyFieldName,
    DependencyResolutionOptions | false,
  ][]) {
    if (options === false) {
      delete pnpmExportInputPackageJson[fieldName];
      continue;
    }

    const filteredDependencies = filterDependencyMapForPnpmExport(
      packageJson[fieldName],
      options,
      privateWorkspacePackageNames,
    );
    if (filteredDependencies) {
      pnpmExportInputPackageJson[fieldName] = filteredDependencies;
    } else {
      delete pnpmExportInputPackageJson[fieldName];
    }
  }

  return pnpmExportInputPackageJson;
}

async function createPnpmExportablePackageJson(
  packageRootDirectory: string,
  packageJson: PackageJsonObject,
  workspaceRootDirectory: string,
  dependencyFields: Partial<
    Record<DependencyFieldName, DependencyResolutionOptions | false>
  >,
): Promise<PnpmExportablePackageJsonResult> {
  const workspaceManifest = await readWorkspaceManifest(workspaceRootDirectory);
  const privateWorkspacePackageNames =
    await collectPrivateWorkspacePackageNames(
      workspaceRootDirectory,
      workspaceManifest,
    );
  const exportablePackageJson = (await createExportableManifest(
    packageRootDirectory,
    createPnpmExportInputPackageJson(
      packageJson,
      dependencyFields,
      privateWorkspacePackageNames,
    ) as PnpmProjectManifest,
    {
      catalogs: createWorkspaceCatalogs(workspaceManifest),
    },
  )) as PackageJsonObject;

  return {
    packageJson: exportablePackageJson,
    privateWorkspacePackageNames,
  };
}

function createResolvedVersionRangeMap(
  originalPackageJson: PackageJsonObject,
  resolvedPackageJson: PackageJsonObject,
): Map<string, string> {
  const resolvedVersionRanges = new Map<string, string>();

  for (const fieldName of DEPENDENCY_FIELD_NAMES) {
    const originalDependencies = originalPackageJson[fieldName];
    const resolvedDependencies = resolvedPackageJson[fieldName];
    if (!originalDependencies || !resolvedDependencies) {
      continue;
    }

    for (const [packageName, versionRange] of Object.entries(
      originalDependencies,
    )) {
      const resolvedVersionRange = resolvedDependencies[packageName];
      if (!resolvedVersionRange) {
        continue;
      }

      resolvedVersionRanges.set(
        createDependencyResolutionKey(packageName, versionRange),
        resolvedVersionRange,
      );
    }
  }

  return resolvedVersionRanges;
}

function sanitizeDependencyMap(
  dependencies: DependencyMap | undefined,
  options: DependencyResolutionOptions = {},
  privateWorkspacePackageNames: ReadonlySet<string> = new Set(),
): DependencyMap | undefined {
  if (!dependencies || typeof dependencies !== 'object') {
    return undefined;
  }

  const {
    allowInternal = true,
    dropPrivateWorkspaceDependencies = false,
    dropWorkspaceDependencies = false,
    dropUnsupportedProtocols = false,
    internalScopes = INTERNAL_SCOPES,
  } = options;
  const resolvedEntries = Object.entries(dependencies).flatMap(
    ([packageName, versionRange]) => {
      const isInternal = internalScopes.some((scope) =>
        packageName.startsWith(scope),
      );

      if (!allowInternal && isInternal) {
        return [];
      }

      if (dropWorkspaceDependencies && versionRange.startsWith('workspace:')) {
        return [];
      }

      if (
        dropPrivateWorkspaceDependencies &&
        isPrivateWorkspaceDependency(
          packageName,
          versionRange,
          privateWorkspacePackageNames,
        )
      ) {
        return [];
      }

      const hasNonPublishableProtocol =
        NON_PUBLISHABLE_VERSION_PROTOCOL_PREFIXES.some((prefix) =>
          versionRange.startsWith(prefix),
        );

      if (hasNonPublishableProtocol) {
        if (dropUnsupportedProtocols) {
          return [];
        }

        throw new Error(
          `Unsupported dependency protocol in published manifest: ${packageName}@${versionRange}`,
        );
      }

      return [[packageName, versionRange]];
    },
  );

  return resolvedEntries.length === 0
    ? undefined
    : Object.fromEntries(resolvedEntries);
}

function createPluginContext(
  packageRootDirectory: string,
  workspaceConfigPath: string,
  resolvedVersionRanges: ReadonlyMap<string, string>,
  privateWorkspacePackageNames: ReadonlySet<string>,
): PackageJsonPluginContext {
  const resolvePublishedVersionRange = (
    packageName: string,
    versionRange: string,
  ): string => {
    return (
      resolvedVersionRanges.get(
        createDependencyResolutionKey(packageName, versionRange),
      ) ?? versionRange
    );
  };

  return {
    packageRootDir: packageRootDirectory,
    resolvePublishedVersionRange,
    sanitizeDependencyMap: (dependencies, options) =>
      sanitizeDependencyMap(
        dependencies,
        options,
        privateWorkspacePackageNames,
      ),
    workspaceConfigPath,
  };
}

export function defaultRewriteExportPath({
  condition,
  value,
}: ExportPathRewriteArguments): string {
  if (value.includes('dist/')) {
    return value.replace('dist/', '');
  }

  if (!value.includes('src/') || !value.endsWith('.ts')) {
    return value;
  }

  const rewrittenValue = value.replace('src/', '');
  return condition === 'types' || rewrittenValue.includes('types')
    ? rewrittenValue.replace('.ts', '.d.ts')
    : rewrittenValue.replace('.ts', '.js');
}

function rewriteTypesPath(
  value: string | undefined,
  context: PackageJsonPluginContext,
): string | undefined {
  if (!value) {
    return value;
  }

  return defaultRewriteExportPath({
    condition: 'types',
    context,
    key: '.',
    value,
  });
}

export function defaultRewritePackageExports({
  context,
  exportsField,
  rewriteExportPath,
}: PackageExportsRewriteArguments): Record<string, ExportValue> | undefined {
  if (
    !exportsField ||
    typeof exportsField !== 'object' ||
    Array.isArray(exportsField)
  ) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(exportsField).map(([key, value]): [string, ExportValue] => {
      if (typeof value === 'string') {
        return [
          key,
          rewriteExportPath({
            context,
            key,
            value,
          }),
        ];
      }

      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return [
          key,
          Object.fromEntries(
            Object.entries(value).map(([condition, conditionValue]) => [
              condition,
              typeof conditionValue === 'string'
                ? rewriteExportPath({
                    condition,
                    context,
                    key,
                    value: conditionValue,
                  })
                : conditionValue,
            ]),
          ),
        ];
      }

      return [key, value as ExportValue];
    }),
  );
}

function sanitizeDependencyFields(
  packageJson: PackageJsonObject,
  context: PackageJsonPluginContext,
  dependencyFields: Partial<
    Record<DependencyFieldName, DependencyResolutionOptions | false>
  >,
): void {
  for (const [fieldName, options] of Object.entries(dependencyFields) as [
    DependencyFieldName,
    DependencyResolutionOptions | false,
  ][]) {
    if (options === false) {
      delete packageJson[fieldName];
      continue;
    }

    const sanitizedDependencies = context.sanitizeDependencyMap(
      packageJson[fieldName],
      options,
    );
    if (sanitizedDependencies) {
      packageJson[fieldName] = sanitizedDependencies;
    } else {
      delete packageJson[fieldName];
    }
  }
}

export function createPackagePlugin(
  options: CreatePackagePluginOptions,
): PackagePluginLike {
  const {
    dependencyFields = DEFAULT_DEPENDENCY_FIELDS,
    emitAssets = [],
    exports: packageExportsRewriter = defaultRewritePackageExports,
    packageJsonPath,
    pluginName = 'generate-package-json',
    rewriteTypes: shouldRewriteTypes = false,
    transformPackageJson,
  } = options;

  const packageRootDirectory = path.dirname(packageJsonPath);
  const packageJson = JSON.parse(
    readFileSync(packageJsonPath, 'utf8'),
  ) as PackageJsonObject;
  const workspaceRootDirectory = findMonorepoRoot(packageRootDirectory);
  if (!workspaceRootDirectory) {
    throw new Error(
      `Unable to resolve workspace root from package manifest: ${packageJsonPath}`,
    );
  }

  const workspaceConfigPath = path.join(
    workspaceRootDirectory,
    'pnpm-workspace.yaml',
  );
  if (!existsSync(workspaceConfigPath)) {
    throw new Error(
      `Unable to resolve pnpm workspace config from workspace root: ${workspaceRootDirectory}`,
    );
  }

  return {
    name: pluginName,
    generateBundle: {
      order: 'post',
      async handler(
        this: PackagePluginContextLike,
        outputOptions: OutputOptionsLike | undefined,
      ) {
        const {
          packageJson: resolvedPackageJson,
          privateWorkspacePackageNames,
        } = await createPnpmExportablePackageJson(
          packageRootDirectory,
          packageJson,
          workspaceRootDirectory,
          dependencyFields,
        );
        const context = createPluginContext(
          packageRootDirectory,
          workspaceConfigPath,
          createResolvedVersionRangeMap(packageJson, resolvedPackageJson),
          privateWorkspacePackageNames,
        );
        const packageJsonObject: PackageJsonObject = {
          ...resolvedPackageJson,
        };

        for (const fieldName of DEFAULT_REMOVE_FIELDS) {
          delete packageJsonObject[fieldName];
        }

        if (shouldRewriteTypes) {
          packageJsonObject.types = rewriteTypesPath(
            packageJsonObject.types,
            context,
          );
        }

        if (packageExportsRewriter !== false) {
          packageJsonObject.exports = packageExportsRewriter({
            context,
            exportsField: packageJsonObject.exports,
            rewriteExportPath: defaultRewriteExportPath,
          });
        }

        sanitizeDependencyFields(packageJsonObject, context, dependencyFields);
        transformPackageJson?.(packageJsonObject, context);

        this.emitFile({
          type: 'asset',
          source: JSON.stringify(packageJsonObject, null, 2),
          fileName: 'package.json',
        });

        const configuredAssetFileNames = new Set(
          emitAssets.map((asset) => asset.fileName),
        );
        const packageFileAssets = await collectPackageFiles(
          packageRootDirectory,
          packageJson.files,
          outputOptions,
        );
        for (const asset of packageFileAssets) {
          if (
            GENERATED_ASSET_FILE_NAMES.has(asset.fileName) ||
            configuredAssetFileNames.has(asset.fileName)
          ) {
            continue;
          }

          this.emitFile({
            type: 'asset',
            source: readFileSync(asset.sourcePath),
            fileName: asset.fileName,
          });
        }

        for (const asset of emitAssets) {
          const source = readFileSync(asset.sourcePath, 'utf8');
          this.emitFile({
            type: 'asset',
            source: asset.transform ? asset.transform(source) : source,
            fileName: asset.fileName,
          });
        }
      },
    },
  };
}

export type {
  ExportPathRewriteArguments as ExportPathRewriteArgs,
  PackageExportsRewriteArguments as PackageExportsRewriteArgs,
};
