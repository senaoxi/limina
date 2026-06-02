import { createElapsedTimer } from 'logaria/helper';
import { existsSync } from 'node:fs';
import path from 'pathe';
import { glob } from 'tinyglobby';
import type { CheckerProjectParseContext } from '../checkers';
import {
  getActiveCheckerExtensions,
  getActiveCheckers,
  isStrictConfig,
  type ResolvedLiminaConfig,
} from '../config';
import type { LiminaFlowReporter } from '../flow';
import {
  collectImportsFromFile,
  createImportAnalysisContext,
  getTypecheckConfigPath,
  type ImportRecord,
  isDtsProjectConfig,
  isRelativeSpecifier,
  parseProject,
  type ProjectInfo,
  resolveInternalImport,
} from '../graph-context';
import { isNodeBuiltinSpecifier } from '../graph-rules';
import {
  collectKnipSourceIssues,
  type KnipOwnerProject,
  type KnipSourceIssues,
} from '../knip';
import { clearCliScreen, formatErrorMessage, SourceLogger } from '../logger';
import {
  collectSourceGraphProjectExtensions,
  isOrdinaryTypecheckConfigPath,
  readJsonConfig,
} from '../tsconfig';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  normalizeSlashes,
  toRelativePath,
} from '../utils/path';
import {
  collectPackageOwners,
  collectWorkspacePackages,
  getPackageRootSpecifier,
  type PackageManifest,
  type PackageOwner,
  readJsonFile,
  type WorkspacePackage,
} from '../workspace';

export interface RunSourceCheckOptions {
  clearScreen?: boolean;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
}

interface SourceProjectEntry {
  fileNames: string[];
  project: ProjectInfo;
}

interface OwnerSourceModuleSet {
  checkUnusedFiles: boolean;
  files: string[];
  owner: PackageOwner;
}

interface PackageImportMatch {
  key: string;
}

type DependencySectionName =
  | 'dependencies'
  | 'devDependencies'
  | 'peerDependencies'
  | 'optionalDependencies';

interface DependencyDeclaration {
  sectionName: DependencySectionName;
  specifier: string;
}

interface WorkspaceDependencyDeclaration {
  dependencyName: string;
  importer: WorkspacePackage;
  packageJsonPath: string;
  sectionName: DependencySectionName;
  specifier: string;
}

interface NearestPackageInfo {
  directory: string;
  manifest: PackageManifest;
  name?: string;
  packageJsonPath: string;
}

type ResolvedPackageTarget =
  | {
      kind: 'current-owner';
      packageInfo: NearestPackageInfo;
    }
  | {
      kind: 'other-owner';
      packageInfo: NearestPackageInfo;
      targetOwner: PackageOwner;
      workspacePackage: WorkspacePackage | null;
    }
  | {
      kind: 'artifact-package';
      packageInfo: NearestPackageInfo;
    }
  | {
      kind: 'unowned';
    };

const dependencySectionNames: DependencySectionName[] = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function formatUnknownValue(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }

  return JSON.stringify(value);
}

function findOwnerForFile(
  filePath: string,
  owners: PackageOwner[],
): PackageOwner | null {
  return (
    owners
      .filter((owner) => isPathInsideDirectory(filePath, owner.directory))
      .sort(
        (left, right) => right.directory.length - left.directory.length,
      )[0] ?? null
  );
}

function findNearestPackageInfo(
  filePath: string,
  options: { requireName?: boolean } = {},
): NearestPackageInfo | null {
  let currentDir = normalizeAbsolutePath(path.dirname(filePath));

  while (true) {
    const packageJsonPath = normalizeAbsolutePath(
      path.join(currentDir, 'package.json'),
    );

    if (existsSync(packageJsonPath)) {
      const manifest = readJsonFile<PackageManifest>(packageJsonPath);
      const name =
        typeof manifest.name === 'string' && manifest.name.trim().length > 0
          ? manifest.name.trim()
          : undefined;

      if (!options.requireName || name) {
        return {
          directory: currentDir,
          manifest,
          name,
          packageJsonPath,
        };
      }
    }

    const parentDir = path.dirname(currentDir);

    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

function findOwnerForPackageInfo(
  packageInfo: NearestPackageInfo,
  owners: PackageOwner[],
): PackageOwner | null {
  return (
    owners.find(
      (owner) => owner.packageJsonPath === packageInfo.packageJsonPath,
    ) ?? null
  );
}

function findWorkspacePackageForPackageInfo(
  packageInfo: NearestPackageInfo,
  packages: WorkspacePackage[],
): WorkspacePackage | null {
  return (
    packages.find((workspacePackage) => {
      const packageJsonPath = normalizeAbsolutePath(
        path.join(workspacePackage.directory, 'package.json'),
      );

      return (
        packageJsonPath === packageInfo.packageJsonPath ||
        (packageInfo.name !== undefined &&
          workspacePackage.name === packageInfo.name)
      );
    }) ?? null
  );
}

function classifyResolvedPackageTarget(options: {
  owner: PackageOwner;
  owners: PackageOwner[];
  packages: WorkspacePackage[];
  resolvedFilePath: string;
}): ResolvedPackageTarget {
  const packageInfo = findNearestPackageInfo(options.resolvedFilePath);

  if (!packageInfo) {
    return {
      kind: 'unowned',
    };
  }

  if (packageInfo.packageJsonPath === options.owner.packageJsonPath) {
    return {
      kind: 'current-owner',
      packageInfo,
    };
  }

  const targetOwner = findOwnerForPackageInfo(packageInfo, options.owners);

  if (targetOwner) {
    return {
      kind: 'other-owner',
      packageInfo,
      targetOwner,
      workspacePackage: findWorkspacePackageForPackageInfo(
        packageInfo,
        options.packages,
      ),
    };
  }

  const artifactPackageInfo =
    packageInfo.name === undefined
      ? findNearestPackageInfo(options.resolvedFilePath, {
          requireName: true,
        })
      : packageInfo;

  return {
    kind: 'artifact-package',
    packageInfo: artifactPackageInfo ?? packageInfo,
  };
}

function isUrlOrDataOrFileSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith('data:') ||
    specifier.startsWith('file:') ||
    specifier.startsWith('http:') ||
    specifier.startsWith('https:')
  );
}

function isVirtualModuleSpecifier(specifier: string): boolean {
  return specifier.startsWith('virtual:');
}

function isPackageImportSpecifier(specifier: string): boolean {
  return specifier.startsWith('#');
}

function isBarePackageSpecifier(specifier: string): boolean {
  return (
    !isRelativeSpecifier(specifier) &&
    !isPackageImportSpecifier(specifier) &&
    !isUrlOrDataOrFileSpecifier(specifier) &&
    !isVirtualModuleSpecifier(specifier) &&
    !path.isAbsolute(specifier)
  );
}

function collectDependencyDeclarations(
  manifest: PackageManifest,
  packageName: string,
): DependencyDeclaration[] {
  const declarations: DependencyDeclaration[] = [];

  for (const sectionName of dependencySectionNames) {
    const section = manifest[sectionName];

    if (!section || typeof section !== 'object') {
      continue;
    }

    const specifier = section[packageName];

    if (typeof specifier !== 'string') {
      continue;
    }

    declarations.push({
      sectionName,
      specifier,
    });
  }

  return declarations;
}

function createWorkspaceDependencyKey(
  importerName: string,
  dependencyName: string,
): string {
  return `${importerName}\0${dependencyName}`;
}

function createPackageDependencyIssueKey(
  packageJsonPath: string,
  dependencyName: string,
): string {
  return `${normalizeAbsolutePath(packageJsonPath)}\0${dependencyName}`;
}

function getWorkspacePackageJsonPath(
  workspacePackage: WorkspacePackage,
): string {
  return path.join(workspacePackage.directory, 'package.json');
}

function getDependencySection(
  manifest: PackageManifest,
  sectionName: DependencySectionName,
): Record<string, string> | null {
  const section = manifest[sectionName];

  if (!isPlainRecord(section)) {
    return null;
  }

  return Object.fromEntries(
    Object.entries(section).filter((entry): entry is [string, string] => {
      return typeof entry[1] === 'string';
    }),
  );
}

function collectWorkspaceDependencyDeclarations(
  workspacePackages: WorkspacePackage[],
): WorkspaceDependencyDeclaration[] {
  const workspacePackageNames = new Set(
    workspacePackages.map((workspacePackage) => workspacePackage.name),
  );
  const declarations: WorkspaceDependencyDeclaration[] = [];

  for (const importer of workspacePackages) {
    for (const sectionName of dependencySectionNames) {
      const section = getDependencySection(importer.manifest, sectionName);

      if (!section) {
        continue;
      }

      for (const [dependencyName, specifier] of Object.entries(section)) {
        if (
          dependencyName === importer.name ||
          !workspacePackageNames.has(dependencyName)
        ) {
          continue;
        }

        declarations.push({
          dependencyName,
          importer,
          packageJsonPath: getWorkspacePackageJsonPath(importer),
          sectionName,
          specifier,
        });
      }
    }
  }

  return declarations.sort((left, right) => {
    if (left.packageJsonPath !== right.packageJsonPath) {
      return left.packageJsonPath.localeCompare(right.packageJsonPath);
    }

    if (left.dependencyName !== right.dependencyName) {
      return left.dependencyName.localeCompare(right.dependencyName);
    }

    return left.sectionName.localeCompare(right.sectionName);
  });
}

function collectUnusedDependencyIgnore(options: {
  config: ResolvedLiminaConfig;
  declarations: WorkspaceDependencyDeclaration[];
  problems: string[];
  workspacePackages: WorkspacePackage[];
}): Set<string> {
  const ignoredKeys = new Set<string>();
  const rawConfig = options.config.source?.unusedDependencies;

  if (rawConfig === undefined) {
    return ignoredKeys;
  }

  if (!isPlainRecord(rawConfig)) {
    options.problems.push(
      [
        'Invalid unused dependency config:',
        '  field: source.unusedDependencies',
        `  value: ${formatUnknownValue(rawConfig)}`,
        '  reason: source.unusedDependencies must be an object.',
      ].join('\n'),
    );
    return ignoredKeys;
  }

  const rawIgnore = rawConfig.ignore;

  if (rawIgnore === undefined) {
    return ignoredKeys;
  }

  if (!Array.isArray(rawIgnore)) {
    options.problems.push(
      [
        'Invalid unused dependency ignore config:',
        '  field: source.unusedDependencies.ignore',
        `  value: ${formatUnknownValue(rawIgnore)}`,
        '  reason: ignore must be an array.',
      ].join('\n'),
    );
    return ignoredKeys;
  }

  const workspacePackageNames = new Set(
    options.workspacePackages.map((workspacePackage) => workspacePackage.name),
  );
  const declarationKeys = new Set(
    options.declarations.map((declaration) =>
      createWorkspaceDependencyKey(
        declaration.importer.name,
        declaration.dependencyName,
      ),
    ),
  );

  for (const [index, entry] of rawIgnore.entries()) {
    const field = `source.unusedDependencies.ignore[${index}]`;

    if (!isPlainRecord(entry)) {
      options.problems.push(
        [
          'Invalid unused dependency ignore config:',
          `  field: ${field}`,
          `  value: ${formatUnknownValue(entry)}`,
          '  reason: ignore entries must be objects with non-empty importer, dependency, and reason fields.',
        ].join('\n'),
      );
      continue;
    }

    const importerValue = entry.importer;
    const dependencyValue = entry.dependency;
    const reasonValue = entry.reason;

    if (
      typeof importerValue !== 'string' ||
      importerValue.trim().length === 0
    ) {
      options.problems.push(
        [
          'Invalid unused dependency ignore config:',
          `  field: ${field}.importer`,
          `  value: ${formatUnknownValue(importerValue)}`,
          '  reason: importer must be a non-empty workspace package name.',
        ].join('\n'),
      );
      continue;
    }

    if (
      typeof dependencyValue !== 'string' ||
      dependencyValue.trim().length === 0
    ) {
      options.problems.push(
        [
          'Invalid unused dependency ignore config:',
          `  field: ${field}.dependency`,
          `  value: ${formatUnknownValue(dependencyValue)}`,
          '  reason: dependency must be a non-empty workspace package name.',
        ].join('\n'),
      );
      continue;
    }

    if (typeof reasonValue !== 'string' || reasonValue.trim().length === 0) {
      options.problems.push(
        [
          'Invalid unused dependency ignore config:',
          `  field: ${field}.reason`,
          `  value: ${formatUnknownValue(reasonValue)}`,
          '  reason: reason must be a non-empty string.',
        ].join('\n'),
      );
      continue;
    }

    const importerName = importerValue.trim();
    const dependencyName = dependencyValue.trim();
    const dependencyKey = createWorkspaceDependencyKey(
      importerName,
      dependencyName,
    );

    if (!workspacePackageNames.has(importerName)) {
      options.problems.push(
        [
          'Invalid unused dependency ignore config:',
          `  field: ${field}.importer`,
          `  importer: ${importerName}`,
          '  reason: importer must name a package from the pnpm workspace.',
        ].join('\n'),
      );
      continue;
    }

    if (!workspacePackageNames.has(dependencyName)) {
      options.problems.push(
        [
          'Invalid unused dependency ignore config:',
          `  field: ${field}.dependency`,
          `  dependency: ${dependencyName}`,
          '  reason: dependency must name a package from the pnpm workspace.',
        ].join('\n'),
      );
      continue;
    }

    if (!declarationKeys.has(dependencyKey)) {
      options.problems.push(
        [
          'Invalid unused dependency ignore config:',
          `  field: ${field}`,
          `  importer: ${importerName}`,
          `  dependency: ${dependencyName}`,
          '  reason: ignore entries must match a workspace dependency declared by the importer package manifest.',
        ].join('\n'),
      );
      continue;
    }

    ignoredKeys.add(dependencyKey);
  }

  return ignoredKeys;
}

function isDependencyAuthorized(
  manifest: PackageManifest,
  packageName: string,
): boolean {
  return collectDependencyDeclarations(manifest, packageName).length > 0;
}

function findWorkspaceDependencyDeclaration(
  manifest: PackageManifest,
  packageName: string,
): DependencyDeclaration | null {
  return (
    collectDependencyDeclarations(manifest, packageName).find((declaration) =>
      declaration.specifier.startsWith('workspace:'),
    ) ?? null
  );
}

function findPackageImportMatch(
  importsField: PackageManifest['imports'],
  specifier: string,
): PackageImportMatch | null {
  if (!importsField || typeof importsField !== 'object') {
    return null;
  }

  for (const key of Object.keys(importsField)) {
    if (key === specifier) {
      return {
        key,
      };
    }

    const wildcardIndex = key.indexOf('*');

    if (wildcardIndex === -1) {
      continue;
    }

    const prefix = key.slice(0, wildcardIndex);
    const suffix = key.slice(wildcardIndex + 1);

    if (specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
      return {
        key,
      };
    }
  }

  return null;
}

function addProjectOwnerProblems(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  fileNames: string[];
  owners: PackageOwner[];
  problems: string[];
  role: 'declaration leaf' | 'typecheck companion';
}): void {
  const ownerPaths = new Map<string, PackageOwner>();
  const missingOwnerFiles: string[] = [];

  for (const fileName of options.fileNames) {
    const owner = findOwnerForFile(fileName, options.owners);

    if (!owner) {
      missingOwnerFiles.push(fileName);
      continue;
    }

    ownerPaths.set(owner.packageJsonPath, owner);
  }

  if (missingOwnerFiles.length > 0) {
    options.problems.push(
      [
        'Source file has no package owner:',
        `  ${options.role}: ${toRelativePath(options.config.rootDir, options.configPath)}`,
        '  files:',
        ...missingOwnerFiles
          .slice(0, 10)
          .map(
            (fileName) =>
              `    - ${toRelativePath(options.config.rootDir, fileName)}`,
          ),
        ...(missingOwnerFiles.length > 10
          ? [`    ...and ${missingOwnerFiles.length - 10} more`]
          : []),
        '  reason: every source file checked by Limina must be governed by the nearest package.json owner.',
      ].join('\n'),
    );
  }

  if (ownerPaths.size <= 1) {
    return;
  }

  options.problems.push(
    [
      'Tsconfig source file set mixes package owners:',
      `  ${options.role}: ${toRelativePath(options.config.rootDir, options.configPath)}`,
      '  owners:',
      ...[...ownerPaths.values()].map(
        (owner) =>
          `    - ${toRelativePath(options.config.rootDir, owner.packageJsonPath)}`,
      ),
      '  reason: non-aggregator tsconfig leaves and their companion typecheck configs must stay within one nearest package.json owner scope.',
    ].join('\n'),
  );
}

function addRelativeImportOwnerProblem(options: {
  config: ResolvedLiminaConfig;
  importRecord: ImportRecord;
  owner: PackageOwner;
  problems: string[];
  resolvedFilePath: string;
  targetOwner: PackageOwner | null;
}): void {
  options.problems.push(
    [
      'Relative import escapes package owner scope:',
      `  package owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
      `  file: ${toRelativePath(options.config.rootDir, options.importRecord.filePath)}:${options.importRecord.line}`,
      `  imported specifier: ${options.importRecord.specifier}`,
      `  resolved file: ${toRelativePath(options.config.rootDir, options.resolvedFilePath)}`,
      ...(options.targetOwner
        ? [
            `  target owner: ${toRelativePath(options.config.rootDir, options.targetOwner.packageJsonPath)}`,
          ]
        : []),
      '  reason: relative source imports must not cross the nearest package.json owner boundary.',
    ].join('\n'),
  );
}

function addPackageImportAuthorizationProblem(options: {
  config: ResolvedLiminaConfig;
  dependencySpecifier?: string;
  importRecord: ImportRecord;
  owner: PackageOwner;
  packageName: string;
  problems: string[];
  workspacePackage: WorkspacePackage | null;
}): void {
  options.problems.push(
    [
      'Unauthorized bare package import:',
      `  package owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
      `  file: ${toRelativePath(options.config.rootDir, options.importRecord.filePath)}:${options.importRecord.line}`,
      `  imported specifier: ${options.importRecord.specifier}`,
      `  package: ${options.packageName}`,
      ...(options.dependencySpecifier
        ? [`  resolved dependency specifier: ${options.dependencySpecifier}`]
        : []),
      ...(options.workspacePackage
        ? [`  workspace package: ${options.workspacePackage.name}`]
        : []),
      '  reason: source imports must be authorized by the nearest package.json dependencies, devDependencies, peerDependencies, or optionalDependencies.',
    ].join('\n'),
  );
}

function addResolvedPackageWithoutNameProblem(options: {
  config: ResolvedLiminaConfig;
  importRecord: ImportRecord;
  owner: PackageOwner;
  packageInfo: NearestPackageInfo;
  problems: string[];
}): void {
  options.problems.push(
    [
      'Resolved package import has no package name:',
      `  package owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
      `  file: ${toRelativePath(options.config.rootDir, options.importRecord.filePath)}:${options.importRecord.line}`,
      `  imported specifier: ${options.importRecord.specifier}`,
      `  resolved package.json: ${toRelativePath(options.config.rootDir, options.packageInfo.packageJsonPath)}`,
      '  reason: source imports can only be authorized against a named package.json dependency.',
    ].join('\n'),
  );
}

function addPackageImportOtherOwnerProblem(options: {
  config: ResolvedLiminaConfig;
  importRecord: ImportRecord;
  owner: PackageOwner;
  problems: string[];
  targetOwner: PackageOwner;
  workspacePackage: WorkspacePackage | null;
}): void {
  options.problems.push(
    [
      'Package import resolves to another package owner:',
      `  package owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
      `  file: ${toRelativePath(options.config.rootDir, options.importRecord.filePath)}:${options.importRecord.line}`,
      `  imported specifier: ${options.importRecord.specifier}`,
      `  target owner: ${toRelativePath(options.config.rootDir, options.targetOwner.packageJsonPath)}`,
      ...(options.workspacePackage
        ? [`  workspace package: ${options.workspacePackage.name}`]
        : []),
      '  reason: #... package imports must not resolve to modules governed by another package.json owner.',
    ].join('\n'),
  );
}

function addStrictWorkspaceDependencyProblem(options: {
  config: ResolvedLiminaConfig;
  importRecord: ImportRecord;
  owner: PackageOwner;
  packageName: string;
  problems: string[];
}): void {
  const declarations = collectDependencyDeclarations(
    options.owner.manifest,
    options.packageName,
  );

  options.problems.push(
    [
      'Workspace bare package import must use workspace: dependency:',
      `  package owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
      `  file: ${toRelativePath(options.config.rootDir, options.importRecord.filePath)}:${options.importRecord.line}`,
      `  imported specifier: ${options.importRecord.specifier}`,
      `  package: ${options.packageName}`,
      ...declarations.map(
        (declaration) =>
          `  found in ${declaration.sectionName}: ${declaration.specifier}`,
      ),
      '  reason: strict: true requires imports that resolve to another workspace package to be declared with the workspace: protocol.',
    ].join('\n'),
  );
}

function addPackageImportProblem(options: {
  config: ResolvedLiminaConfig;
  importRecord: ImportRecord;
  owner: PackageOwner;
  owners: PackageOwner[];
  packages: WorkspacePackage[];
  problems: string[];
  resolvedFilePath: string | null;
}): void {
  const match = findPackageImportMatch(
    options.owner.manifest.imports,
    options.importRecord.specifier,
  );

  if (!match) {
    options.problems.push(
      [
        'Unauthorized package import specifier:',
        `  package owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
        `  file: ${toRelativePath(options.config.rootDir, options.importRecord.filePath)}:${options.importRecord.line}`,
        `  imported specifier: ${options.importRecord.specifier}`,
        '  reason: #... package imports must match the nearest package.json imports field.',
      ].join('\n'),
    );
    return;
  }

  if (!options.resolvedFilePath) {
    options.problems.push(
      [
        'Unresolved package import specifier:',
        `  package owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
        `  file: ${toRelativePath(options.config.rootDir, options.importRecord.filePath)}:${options.importRecord.line}`,
        `  imported specifier: ${options.importRecord.specifier}`,
        '  reason: matched #... package imports must resolve to a file within the same package owner scope.',
      ].join('\n'),
    );
    return;
  }

  const target = classifyResolvedPackageTarget({
    owner: options.owner,
    owners: options.owners,
    packages: options.packages,
    resolvedFilePath: options.resolvedFilePath,
  });

  if (target.kind === 'current-owner') {
    return;
  }

  if (target.kind === 'other-owner') {
    addPackageImportOtherOwnerProblem({
      config: options.config,
      importRecord: options.importRecord,
      owner: options.owner,
      problems: options.problems,
      targetOwner: target.targetOwner,
      workspacePackage: target.workspacePackage,
    });
    return;
  }

  if (target.kind === 'artifact-package') {
    if (!target.packageInfo.name) {
      addResolvedPackageWithoutNameProblem({
        config: options.config,
        importRecord: options.importRecord,
        owner: options.owner,
        packageInfo: target.packageInfo,
        problems: options.problems,
      });
      return;
    }

    if (
      isDependencyAuthorized(options.owner.manifest, target.packageInfo.name)
    ) {
      return;
    }

    addPackageImportAuthorizationProblem({
      config: options.config,
      dependencySpecifier: target.packageInfo.name,
      importRecord: options.importRecord,
      owner: options.owner,
      packageName: target.packageInfo.name,
      problems: options.problems,
      workspacePackage: null,
    });
    return;
  }

  options.problems.push(
    [
      'Package import resolves outside package ownership:',
      `  package owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
      `  file: ${toRelativePath(options.config.rootDir, options.importRecord.filePath)}:${options.importRecord.line}`,
      `  imported specifier: ${options.importRecord.specifier}`,
      `  resolved file: ${toRelativePath(options.config.rootDir, options.resolvedFilePath)}`,
      '  reason: #... package imports must resolve to the current package owner or to a named artifact package dependency.',
    ].join('\n'),
  );
}

async function collectSourceGovernanceTsconfigPaths(
  config: ResolvedLiminaConfig,
): Promise<string[]> {
  const paths = await glob('**/tsconfig*.json', {
    cwd: config.rootDir,
    absolute: true,
    ignore: [
      '**/.git/**',
      '**/.tsbuild/**',
      '**/coverage/**',
      '**/dist/**',
      '**/node_modules/**',
    ],
  });

  return paths
    .map(normalizeAbsolutePath)
    .filter(isOrdinaryTypecheckConfigPath)
    .sort();
}

function isEmptyFilesArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

function isReferenceOnlySolutionConfig(
  configObject: Record<string, unknown>,
): boolean {
  return (
    Object.hasOwn(configObject, 'references') &&
    !Object.hasOwn(configObject, 'include') &&
    (!Object.hasOwn(configObject, 'files') ||
      isEmptyFilesArray(configObject.files))
  );
}

function shouldSkipGovernedTsconfig(
  configObject: Record<string, unknown>,
): boolean {
  return isReferenceOnlySolutionConfig(configObject);
}

function getSourceGovernanceContext(
  config: ResolvedLiminaConfig,
): CheckerProjectParseContext {
  return {
    checkerPresets: [
      ...new Set(getActiveCheckers(config).map((checker) => checker.preset)),
    ],
    extensions: getActiveCheckerExtensions(config),
  };
}

async function addTsconfigGovernanceProblems(options: {
  config: ResolvedLiminaConfig;
  owners: PackageOwner[];
  problems: string[];
}): Promise<void> {
  const configPaths = await collectSourceGovernanceTsconfigPaths(
    options.config,
  );
  const context = getSourceGovernanceContext(options.config);
  const governanceUnitsByFile = new Map<
    string,
    Map<string, { configPaths: string[]; owner: PackageOwner }>
  >();

  for (const configPath of configPaths) {
    const configObject = readJsonConfig(options.config, configPath);

    if (shouldSkipGovernedTsconfig(configObject)) {
      continue;
    }

    const owner = findOwnerForFile(configPath, options.owners);

    if (!owner) {
      options.problems.push(
        [
          'Tsconfig has no package owner:',
          `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
          '  reason: every tsconfig*.json that governs modules must be assigned to its nearest package.json.',
        ].join('\n'),
      );
      continue;
    }

    const project = parseProject(options.config, configPath, context);
    const unitKey = configPath;

    for (const fileName of project.fileNames) {
      const fileOwner = findOwnerForFile(fileName, options.owners);

      if (fileOwner?.packageJsonPath !== owner.packageJsonPath) {
        options.problems.push(
          [
            'Tsconfig source file set crosses package owner scope:',
            `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
            `  package owner: ${toRelativePath(options.config.rootDir, owner.packageJsonPath)}`,
            `  file: ${toRelativePath(options.config.rootDir, fileName)}`,
            ...(fileOwner
              ? [
                  `  file owner: ${toRelativePath(options.config.rootDir, fileOwner.packageJsonPath)}`,
                ]
              : []),
            '  reason: every package-owned tsconfig*.json must govern only modules owned by the same nearest package.json.',
          ].join('\n'),
        );
      }

      const governanceUnits =
        governanceUnitsByFile.get(fileName) ??
        new Map<string, { configPaths: string[]; owner: PackageOwner }>();
      const governanceUnit = governanceUnits.get(unitKey) ?? {
        configPaths: [],
        owner,
      };

      governanceUnit.configPaths.push(configPath);
      governanceUnits.set(unitKey, governanceUnit);
      governanceUnitsByFile.set(fileName, governanceUnits);
    }
  }

  for (const [fileName, governanceUnits] of [
    ...governanceUnitsByFile.entries(),
  ].sort(([left], [right]) =>
    toRelativePath(options.config.rootDir, left).localeCompare(
      toRelativePath(options.config.rootDir, right),
    ),
  )) {
    if (governanceUnits.size <= 1) {
      continue;
    }

    const uniqueOwners = [
      ...new Set(
        [...governanceUnits.values()].map((unit) => unit.owner.packageJsonPath),
      ),
    ];

    options.problems.push(
      [
        'Source module belongs to multiple tsconfig governance units:',
        `  file: ${toRelativePath(options.config.rootDir, fileName)}`,
        '  configs:',
        ...[...governanceUnits.values()]
          .flatMap((unit) => unit.configPaths)
          .sort((left, right) =>
            toRelativePath(options.config.rootDir, left).localeCompare(
              toRelativePath(options.config.rootDir, right),
            ),
          )
          .map(
            (configPath) =>
              `    - ${toRelativePath(options.config.rootDir, configPath)}`,
          ),
        '  reason: a module may belong to only one ordinary typecheck tsconfig*.json governance unit.',
      ].join('\n'),
    );

    if (uniqueOwners.length <= 1) {
      continue;
    }

    options.problems.push(
      [
        'Source module belongs to multiple package owners:',
        `  file: ${toRelativePath(options.config.rootDir, fileName)}`,
        '  package owners:',
        ...uniqueOwners
          .sort((left, right) =>
            toRelativePath(options.config.rootDir, left).localeCompare(
              toRelativePath(options.config.rootDir, right),
            ),
          )
          .map(
            (packageJsonPath) =>
              `    - ${toRelativePath(options.config.rootDir, packageJsonPath)}`,
          ),
        '  reason: source ownership prohibits overlap between module sets governed by different package.json files.',
      ].join('\n'),
    );
  }
}

function createOwnerSourceFileKey(ownerName: string, filePath: string): string {
  return `${ownerName}\0${normalizeAbsolutePath(filePath)}`;
}

function hasProvidedPackageExports(owner: PackageOwner): boolean {
  return Object.hasOwn(owner.manifest, 'exports');
}

interface UnusedModuleConfig {
  entryPatternsByOwnerName: Map<string, string[]>;
  ignoredKeys: Set<string>;
}

function collectOwnerSourceModuleSets(options: {
  owners: PackageOwner[];
  sourceProjectEntries: SourceProjectEntry[];
}): OwnerSourceModuleSet[] {
  const filesByOwner = new Map<
    string,
    { files: Set<string>; owner: PackageOwner }
  >();

  for (const sourceProjectEntry of options.sourceProjectEntries) {
    for (const fileName of sourceProjectEntry.fileNames) {
      const filePath = normalizeAbsolutePath(fileName);
      const owner = findOwnerForFile(filePath, options.owners);

      if (!owner?.name) {
        continue;
      }

      const ownerFiles = filesByOwner.get(owner.packageJsonPath) ?? {
        files: new Set<string>(),
        owner,
      };

      ownerFiles.files.add(filePath);
      filesByOwner.set(owner.packageJsonPath, ownerFiles);
    }
  }

  return [...filesByOwner.values()]
    .map(({ files, owner }) => ({
      checkUnusedFiles: hasProvidedPackageExports(owner),
      files: [...files].sort((left, right) => left.localeCompare(right)),
      owner,
    }))
    .sort((left, right) =>
      left.owner.packageJsonPath.localeCompare(right.owner.packageJsonPath),
    );
}

function normalizeWorkspacePattern(value: string): string {
  let pattern = normalizeSlashes(value.trim());

  while (pattern.startsWith('./')) {
    pattern = pattern.slice(2);
  }

  return pattern;
}

function isInvalidWorkspacePattern(pattern: string): boolean {
  return (
    pattern.startsWith('!') ||
    path.isAbsolute(pattern) ||
    /^[A-Za-z]:[\\/]/u.test(pattern) ||
    pattern === '..' ||
    pattern.startsWith('../') ||
    pattern.includes('/../') ||
    pattern.endsWith('/..')
  );
}

function toOwnerRelativeEntryPattern(options: {
  config: ResolvedLiminaConfig;
  owner: PackageOwner;
  pattern: string;
}): string | null {
  const ownerDirectory = toRelativePath(
    options.config.rootDir,
    options.owner.directory,
  );

  if (ownerDirectory === '.') {
    return options.pattern;
  }

  if (options.pattern === ownerDirectory) {
    return '.';
  }

  if (options.pattern.startsWith(`${ownerDirectory}/`)) {
    return options.pattern.slice(ownerDirectory.length + 1);
  }

  return null;
}

function collectUnusedModuleConfig(options: {
  config: ResolvedLiminaConfig;
  ownerModuleSets: OwnerSourceModuleSet[];
  problems: string[];
}): UnusedModuleConfig {
  const ignoredKeys = new Set<string>();
  const entryPatternsByOwnerName = new Map<string, string[]>();
  const rawConfig = options.config.source?.unusedModules;
  const emptyConfig = {
    entryPatternsByOwnerName,
    ignoredKeys,
  };

  if (rawConfig === undefined) {
    return emptyConfig;
  }

  if (!isPlainRecord(rawConfig)) {
    options.problems.push(
      [
        'Invalid unused module config:',
        '  field: source.unusedModules',
        `  value: ${formatUnknownValue(rawConfig)}`,
        '  reason: source.unusedModules must be an object.',
      ].join('\n'),
    );
    return emptyConfig;
  }

  if (Object.hasOwn(rawConfig, 'enabled')) {
    options.problems.push(
      [
        'Invalid unused module config:',
        '  field: source.unusedModules.enabled',
        `  value: ${formatUnknownValue(rawConfig.enabled)}`,
        '  reason: source.unusedModules.enabled is not supported; strict: true enables unused source module checks automatically.',
      ].join('\n'),
    );
  }

  const moduleSetByOwnerName = new Map(
    options.ownerModuleSets.map((moduleSet) => [
      moduleSet.owner.name as string,
      moduleSet,
    ]),
  );
  const moduleFilesByOwnerName = new Map(
    options.ownerModuleSets.map((moduleSet) => [
      moduleSet.owner.name as string,
      new Set(moduleSet.files),
    ]),
  );
  const rawEntries = rawConfig.entries;
  const rawIgnore = rawConfig.ignore;

  if (rawEntries !== undefined) {
    if (Array.isArray(rawEntries)) {
      for (const [index, entry] of rawEntries.entries()) {
        const field = `source.unusedModules.entries[${index}]`;

        if (!isPlainRecord(entry)) {
          options.problems.push(
            [
              'Invalid unused module entry config:',
              `  field: ${field}`,
              `  value: ${formatUnknownValue(entry)}`,
              '  reason: entry configs must be objects with non-empty owner, files, and reason fields.',
            ].join('\n'),
          );
          continue;
        }

        const ownerValue = entry.owner;
        const filesValue = entry.files;
        const reasonValue = entry.reason;

        if (typeof ownerValue !== 'string' || ownerValue.trim().length === 0) {
          options.problems.push(
            [
              'Invalid unused module entry config:',
              `  field: ${field}.owner`,
              `  value: ${formatUnknownValue(ownerValue)}`,
              '  reason: owner must be a non-empty package owner name.',
            ].join('\n'),
          );
          continue;
        }

        if (!Array.isArray(filesValue) || filesValue.length === 0) {
          options.problems.push(
            [
              'Invalid unused module entry config:',
              `  field: ${field}.files`,
              `  value: ${formatUnknownValue(filesValue)}`,
              '  reason: files must be a non-empty array of workspace-root-relative glob patterns.',
            ].join('\n'),
          );
          continue;
        }

        if (
          typeof reasonValue !== 'string' ||
          reasonValue.trim().length === 0
        ) {
          options.problems.push(
            [
              'Invalid unused module entry config:',
              `  field: ${field}.reason`,
              `  value: ${formatUnknownValue(reasonValue)}`,
              '  reason: reason must be a non-empty string.',
            ].join('\n'),
          );
          continue;
        }

        const ownerName = ownerValue.trim();
        const moduleSet = moduleSetByOwnerName.get(ownerName);

        if (!moduleSet) {
          options.problems.push(
            [
              'Invalid unused module entry config:',
              `  field: ${field}.owner`,
              `  owner: ${ownerName}`,
              '  reason: owner must name an existing package owner with a package.json name.',
            ].join('\n'),
          );
          continue;
        }

        const ownerRelativePatterns =
          entryPatternsByOwnerName.get(ownerName) ?? [];

        for (const [fileIndex, fileValue] of filesValue.entries()) {
          const fileField = `${field}.files[${fileIndex}]`;

          if (typeof fileValue !== 'string' || fileValue.trim().length === 0) {
            options.problems.push(
              [
                'Invalid unused module entry config:',
                `  field: ${fileField}`,
                `  value: ${formatUnknownValue(fileValue)}`,
                '  reason: file patterns must be non-empty strings.',
              ].join('\n'),
            );
            continue;
          }

          const pattern = normalizeWorkspacePattern(fileValue);

          if (isInvalidWorkspacePattern(pattern)) {
            options.problems.push(
              [
                'Invalid unused module entry config:',
                `  field: ${fileField}`,
                `  file: ${pattern}`,
                '  reason: file patterns must be positive workspace-root-relative globs inside the workspace root.',
              ].join('\n'),
            );
            continue;
          }

          const ownerRelativePattern = toOwnerRelativeEntryPattern({
            config: options.config,
            owner: moduleSet.owner,
            pattern,
          });

          if (!ownerRelativePattern) {
            options.problems.push(
              [
                'Invalid unused module entry config:',
                `  field: ${fileField}`,
                `  owner: ${ownerName}`,
                `  file: ${pattern}`,
                '  reason: file patterns must stay inside the owner package directory.',
              ].join('\n'),
            );
            continue;
          }

          ownerRelativePatterns.push(ownerRelativePattern);
        }

        if (ownerRelativePatterns.length > 0) {
          entryPatternsByOwnerName.set(
            ownerName,
            [...new Set(ownerRelativePatterns)].sort(),
          );
        }
      }
    } else {
      options.problems.push(
        [
          'Invalid unused module entry config:',
          '  field: source.unusedModules.entries',
          `  value: ${formatUnknownValue(rawEntries)}`,
          '  reason: entries must be an array.',
        ].join('\n'),
      );
    }
  }

  if (rawIgnore === undefined) {
    return {
      entryPatternsByOwnerName,
      ignoredKeys,
    };
  }

  if (!Array.isArray(rawIgnore)) {
    options.problems.push(
      [
        'Invalid unused module ignore config:',
        '  field: source.unusedModules.ignore',
        `  value: ${formatUnknownValue(rawIgnore)}`,
        '  reason: ignore must be an array.',
      ].join('\n'),
    );
    return {
      entryPatternsByOwnerName,
      ignoredKeys,
    };
  }

  for (const [index, entry] of rawIgnore.entries()) {
    const field = `source.unusedModules.ignore[${index}]`;

    if (!isPlainRecord(entry)) {
      options.problems.push(
        [
          'Invalid unused module ignore config:',
          `  field: ${field}`,
          `  value: ${formatUnknownValue(entry)}`,
          '  reason: ignore entries must be objects with non-empty owner, file, and reason fields.',
        ].join('\n'),
      );
      continue;
    }

    const ownerValue = entry.owner;
    const fileValue = entry.file;
    const reasonValue = entry.reason;

    if (typeof ownerValue !== 'string' || ownerValue.trim().length === 0) {
      options.problems.push(
        [
          'Invalid unused module ignore config:',
          `  field: ${field}.owner`,
          `  value: ${formatUnknownValue(ownerValue)}`,
          '  reason: owner must be a non-empty package owner name.',
        ].join('\n'),
      );
      continue;
    }

    if (typeof fileValue !== 'string' || fileValue.trim().length === 0) {
      options.problems.push(
        [
          'Invalid unused module ignore config:',
          `  field: ${field}.file`,
          `  value: ${formatUnknownValue(fileValue)}`,
          '  reason: file must be a non-empty workspace-root-relative path.',
        ].join('\n'),
      );
      continue;
    }

    if (typeof reasonValue !== 'string' || reasonValue.trim().length === 0) {
      options.problems.push(
        [
          'Invalid unused module ignore config:',
          `  field: ${field}.reason`,
          `  value: ${formatUnknownValue(reasonValue)}`,
          '  reason: reason must be a non-empty string.',
        ].join('\n'),
      );
      continue;
    }

    const ownerName = ownerValue.trim();
    const file = normalizeSlashes(fileValue.trim());
    const moduleSet = moduleSetByOwnerName.get(ownerName);

    if (!moduleSet) {
      options.problems.push(
        [
          'Invalid unused module ignore config:',
          `  field: ${field}.owner`,
          `  owner: ${ownerName}`,
          '  reason: owner must name an existing package owner with a package.json name.',
        ].join('\n'),
      );
      continue;
    }

    if (path.isAbsolute(file) || /^[A-Za-z]:[\\/]/u.test(file)) {
      options.problems.push(
        [
          'Invalid unused module ignore config:',
          `  field: ${field}.file`,
          `  file: ${file}`,
          '  reason: file must be relative to the workspace root.',
        ].join('\n'),
      );
      continue;
    }

    const filePath = normalizeAbsolutePath(
      path.resolve(options.config.rootDir, file),
    );

    if (!isPathInsideDirectory(filePath, options.config.rootDir)) {
      options.problems.push(
        [
          'Invalid unused module ignore config:',
          `  field: ${field}.file`,
          `  file: ${file}`,
          '  reason: file must resolve inside the workspace root.',
        ].join('\n'),
      );
      continue;
    }

    if (!moduleFilesByOwnerName.get(ownerName)?.has(filePath)) {
      options.problems.push(
        [
          'Invalid unused module ignore config:',
          `  field: ${field}.file`,
          `  owner: ${ownerName}`,
          `  file: ${file}`,
          '  reason: file must belong to the owner source module set known to Limina.',
        ].join('\n'),
      );
      continue;
    }

    ignoredKeys.add(createOwnerSourceFileKey(ownerName, filePath));
  }

  return {
    entryPatternsByOwnerName,
    ignoredKeys,
  };
}

function createKnipOwnerProjects(options: {
  entryPatternsByOwnerName: Map<string, string[]>;
  ignoredModuleKeys: Set<string>;
  includeFiles: boolean;
  ownerModuleSets: OwnerSourceModuleSet[];
}): KnipOwnerProject[] {
  return options.ownerModuleSets.map((moduleSet) => ({
    directory: moduleSet.owner.directory,
    entryFiles:
      options.entryPatternsByOwnerName.get(moduleSet.owner.name as string) ??
      [],
    ignoreFiles: moduleSet.files
      .filter((filePath) =>
        options.ignoredModuleKeys.has(
          createOwnerSourceFileKey(moduleSet.owner.name as string, filePath),
        ),
      )
      .map((filePath) => toRelativePath(moduleSet.owner.directory, filePath))
      .sort(),
    projectFiles: options.includeFiles
      ? moduleSet.files
          .map((filePath) =>
            toRelativePath(moduleSet.owner.directory, filePath),
          )
          .sort()
      : [],
    virtualEntrySourceFiles: moduleSet.checkUnusedFiles ? [] : moduleSet.files,
  }));
}

function addUnusedDependencyProblems(options: {
  config: ResolvedLiminaConfig;
  declarations: WorkspaceDependencyDeclaration[];
  ignoredDependencies: Set<string>;
  knipIssues: KnipSourceIssues;
  problems: string[];
}): void {
  const unusedDependencyIssueKeys = new Set(
    options.knipIssues.unusedWorkspaceDependencies.map((issue) =>
      createPackageDependencyIssueKey(
        issue.packageJsonPath,
        issue.dependencyName,
      ),
    ),
  );

  for (const declaration of options.declarations) {
    const dependencyKey = createWorkspaceDependencyKey(
      declaration.importer.name,
      declaration.dependencyName,
    );

    if (options.ignoredDependencies.has(dependencyKey)) {
      continue;
    }

    if (
      !unusedDependencyIssueKeys.has(
        createPackageDependencyIssueKey(
          declaration.packageJsonPath,
          declaration.dependencyName,
        ),
      )
    ) {
      continue;
    }

    options.problems.push(
      [
        'Unused workspace package dependency:',
        `  importer: ${declaration.importer.name}`,
        `  package manifest: ${toRelativePath(options.config.rootDir, declaration.packageJsonPath)}`,
        `  dependency: ${declaration.dependencyName}`,
        `  section: ${declaration.sectionName}`,
        `  specifier: ${declaration.specifier}`,
        '  reason: workspace package dependencies should be reachable from package entries, binaries, scripts, or explicitly ignored when usage is not visible to Knip analysis.',
        `  fix: remove ${declaration.dependencyName} from ${declaration.sectionName}, make it reachable from an entry owned by ${declaration.importer.name}, invoke one of its package binaries from scripts owned by ${declaration.importer.name}, or add source.unusedDependencies.ignore with importer "${declaration.importer.name}", dependency "${declaration.dependencyName}", and a reason.`,
      ].join('\n'),
    );
  }
}

function addUnusedModuleProblems(options: {
  config: ResolvedLiminaConfig;
  ignoredModuleKeys: Set<string>;
  knipIssues: KnipSourceIssues;
  ownerModuleSets: OwnerSourceModuleSet[];
  problems: string[];
}): void {
  const moduleSetByFilePath = new Map<string, OwnerSourceModuleSet>();
  const reportedKeys = new Set<string>();

  for (const moduleSet of options.ownerModuleSets) {
    if (!moduleSet.checkUnusedFiles) {
      continue;
    }

    for (const filePath of moduleSet.files) {
      moduleSetByFilePath.set(filePath, moduleSet);
    }
  }

  for (const issue of options.knipIssues.unusedSourceFiles) {
    const filePath = normalizeAbsolutePath(issue.filePath);
    const moduleSet = moduleSetByFilePath.get(filePath);

    if (!moduleSet?.owner.name) {
      continue;
    }

    const issueKey = createOwnerSourceFileKey(moduleSet.owner.name, filePath);

    if (options.ignoredModuleKeys.has(issueKey) || reportedKeys.has(issueKey)) {
      continue;
    }

    reportedKeys.add(issueKey);

    options.problems.push(
      [
        'Unused source module:',
        `  owner: ${moduleSet.owner.name}`,
        `  package manifest: ${toRelativePath(options.config.rootDir, moduleSet.owner.packageJsonPath)}`,
        `  file: ${toRelativePath(options.config.rootDir, filePath)}`,
        '  reason: strict mode requires owner-governed source modules to be reachable from package entries, binaries, scripts, or Knip plugin entries.',
        `  fix: delete ${toRelativePath(options.config.rootDir, filePath)}, make it reachable from an entry owned by ${moduleSet.owner.name}, or add source.unusedModules.ignore with owner "${moduleSet.owner.name}", file "${toRelativePath(options.config.rootDir, filePath)}", and a reason.`,
      ].join('\n'),
    );
  }
}

async function addKnipBackedSourceProblems(options: {
  config: ResolvedLiminaConfig;
  ownerModuleSets: OwnerSourceModuleSet[];
  problems: string[];
  workspacePackages: WorkspacePackage[];
}): Promise<void> {
  const declarations = collectWorkspaceDependencyDeclarations(
    options.workspacePackages,
  );
  const ignoredDependencies = collectUnusedDependencyIgnore({
    config: options.config,
    declarations,
    problems: options.problems,
    workspacePackages: options.workspacePackages,
  });
  const unusedModuleConfig = collectUnusedModuleConfig({
    config: options.config,
    ownerModuleSets: options.ownerModuleSets,
    problems: options.problems,
  });
  const includeFiles =
    isStrictConfig(options.config) && options.ownerModuleSets.length > 0;
  const needsDependencyAnalysis =
    options.workspacePackages.length > 0 && declarations.length > 0;
  const ownerProjects = createKnipOwnerProjects({
    entryPatternsByOwnerName: unusedModuleConfig.entryPatternsByOwnerName,
    ignoredModuleKeys: unusedModuleConfig.ignoredKeys,
    includeFiles,
    ownerModuleSets: options.ownerModuleSets,
  });
  const hasOwnerProjectEntries = ownerProjects.some(
    (ownerProject) =>
      ownerProject.entryFiles.length > 0 ||
      ownerProject.virtualEntrySourceFiles.length > 0,
  );

  if (!needsDependencyAnalysis && !includeFiles) {
    return;
  }

  const knipIssues = await collectKnipSourceIssues({
    config: options.config,
    ignoredKeys: ignoredDependencies,
    includeFiles,
    ownerProjects:
      includeFiles || (needsDependencyAnalysis && hasOwnerProjectEntries)
        ? ownerProjects
        : [],
    workspacePackages: options.workspacePackages,
  });

  addUnusedDependencyProblems({
    config: options.config,
    declarations,
    ignoredDependencies,
    knipIssues,
    problems: options.problems,
  });

  if (includeFiles) {
    addUnusedModuleProblems({
      config: options.config,
      ignoredModuleKeys: unusedModuleConfig.ignoredKeys,
      knipIssues,
      ownerModuleSets: options.ownerModuleSets,
      problems: options.problems,
    });
  }
}

function createSourceProjectEntries(
  config: ResolvedLiminaConfig,
  projects: ProjectInfo[],
): SourceProjectEntry[] {
  return projects
    .filter((project) => isDtsProjectConfig(project.configPath))
    .map((project) => {
      const typecheckConfigPath = getTypecheckConfigPath(project.configPath);
      const fileNames = new Set(project.fileNames);

      if (existsSync(typecheckConfigPath)) {
        for (const fileName of parseProject(
          config,
          typecheckConfigPath,
          project,
        ).fileNames) {
          fileNames.add(fileName);
        }
      }

      return {
        fileNames: [...fileNames].sort(),
        project,
      };
    });
}

async function runSourceCheckInternal(
  config: ResolvedLiminaConfig,
  options: { logSuccess?: boolean } = {},
): Promise<boolean> {
  const graphRoute = collectSourceGraphProjectExtensions(config);
  const projectPaths = [...graphRoute.projectExtensionsByPath.keys()].sort();
  const projects = projectPaths.map((projectPath) =>
    parseProject(
      config,
      projectPath,
      graphRoute.projectContextsByPath.get(projectPath),
    ),
  );
  const sourceProjectEntries = createSourceProjectEntries(config, projects);
  const packages = await collectWorkspacePackages(config);
  const packageOwners = await collectPackageOwners(config);
  const ownerModuleSets = collectOwnerSourceModuleSets({
    owners: packageOwners,
    sourceProjectEntries,
  });
  const importAnalysis = createImportAnalysisContext();
  const problems: string[] = [...graphRoute.problems];

  await addTsconfigGovernanceProblems({
    config,
    owners: packageOwners,
    problems,
  });
  await addKnipBackedSourceProblems({
    config,
    ownerModuleSets,
    problems,
    workspacePackages: packages,
  });

  for (const project of projects) {
    if (project.labelProblem) {
      problems.push(project.labelProblem);
    }

    if (!isDtsProjectConfig(project.configPath)) {
      continue;
    }

    addProjectOwnerProblems({
      config,
      configPath: project.configPath,
      fileNames: project.fileNames,
      owners: packageOwners,
      problems,
      role: 'declaration leaf',
    });

    const typecheckConfigPath = getTypecheckConfigPath(project.configPath);

    if (existsSync(typecheckConfigPath)) {
      addProjectOwnerProblems({
        config,
        configPath: typecheckConfigPath,
        fileNames: parseProject(config, typecheckConfigPath, project).fileNames,
        owners: packageOwners,
        problems,
        role: 'typecheck companion',
      });
    }
  }

  for (const { fileNames, project } of sourceProjectEntries) {
    for (const filePath of fileNames) {
      const owner = findOwnerForFile(filePath, packageOwners);

      if (!owner) {
        continue;
      }

      for (const importRecord of collectImportsFromFile(
        filePath,
        config.rootDir,
        importAnalysis,
      )) {
        const resolvedFilePath = resolveInternalImport(
          importRecord.specifier,
          filePath,
          project.options,
          project,
          importAnalysis,
        );

        if (isRelativeSpecifier(importRecord.specifier)) {
          if (!resolvedFilePath) {
            continue;
          }

          const targetOwner = findOwnerForFile(resolvedFilePath, packageOwners);

          if (targetOwner?.packageJsonPath !== owner.packageJsonPath) {
            addRelativeImportOwnerProblem({
              config,
              importRecord,
              owner,
              problems,
              resolvedFilePath,
              targetOwner,
            });
          }

          continue;
        }

        if (isPackageImportSpecifier(importRecord.specifier)) {
          addPackageImportProblem({
            config,
            importRecord,
            owner,
            owners: packageOwners,
            packages,
            problems,
            resolvedFilePath,
          });
          continue;
        }

        if (
          isUrlOrDataOrFileSpecifier(importRecord.specifier) ||
          isVirtualModuleSpecifier(importRecord.specifier)
        ) {
          continue;
        }

        if (!isBarePackageSpecifier(importRecord.specifier)) {
          continue;
        }

        if (isNodeBuiltinSpecifier(importRecord.specifier)) {
          continue;
        }

        const fallbackPackageName = getPackageRootSpecifier(
          importRecord.specifier,
        );

        if (owner.name === fallbackPackageName) {
          continue;
        }

        if (resolvedFilePath) {
          const target = classifyResolvedPackageTarget({
            owner,
            owners: packageOwners,
            packages,
            resolvedFilePath,
          });

          if (target.kind === 'current-owner') {
            continue;
          }

          if (target.kind === 'other-owner') {
            const packageName =
              target.packageInfo.name ?? target.targetOwner.name;

            if (!packageName) {
              addResolvedPackageWithoutNameProblem({
                config,
                importRecord,
                owner,
                packageInfo: target.packageInfo,
                problems,
              });
              continue;
            }

            if (!isDependencyAuthorized(owner.manifest, packageName)) {
              addPackageImportAuthorizationProblem({
                config,
                importRecord,
                owner,
                packageName,
                problems,
                workspacePackage: target.workspacePackage,
              });
              continue;
            }

            if (
              target.workspacePackage &&
              isStrictConfig(config) &&
              !findWorkspaceDependencyDeclaration(owner.manifest, packageName)
            ) {
              addStrictWorkspaceDependencyProblem({
                config,
                importRecord,
                owner,
                packageName,
                problems,
              });
            }

            continue;
          }

          if (target.kind === 'artifact-package') {
            if (!target.packageInfo.name) {
              addResolvedPackageWithoutNameProblem({
                config,
                importRecord,
                owner,
                packageInfo: target.packageInfo,
                problems,
              });
              continue;
            }

            if (
              isDependencyAuthorized(owner.manifest, target.packageInfo.name)
            ) {
              continue;
            }

            addPackageImportAuthorizationProblem({
              config,
              importRecord,
              owner,
              packageName: target.packageInfo.name,
              problems,
              workspacePackage: null,
            });
            continue;
          }
        }

        const workspacePackage =
          packages.find(
            (candidate) => candidate.name === fallbackPackageName,
          ) ?? null;

        if (isDependencyAuthorized(owner.manifest, fallbackPackageName)) {
          continue;
        }

        addPackageImportAuthorizationProblem({
          config,
          importRecord,
          owner,
          packageName: fallbackPackageName,
          problems,
          workspacePackage,
        });
      }
    }
  }

  if (problems.length > 0) {
    SourceLogger.error(problems.join('\n\n'));
    return false;
  }

  if (options.logSuccess ?? true) {
    SourceLogger.success(
      `Checked ${sourceProjectEntries.length} source project owners; package scopes are valid.`,
    );
  }

  return true;
}

export async function runSourceCheck(
  config: ResolvedLiminaConfig,
  options: RunSourceCheckOptions = {},
): Promise<boolean> {
  if (options.clearScreen ?? true) {
    clearCliScreen();
  }

  const elapsed = createElapsedTimer();
  const task = options.flow?.start('source check', {
    depth: options.flowDepth ?? 0,
  });

  SourceLogger.info('source check started');

  try {
    const logSuccess = !options.flow?.interactive;
    const passed = await runSourceCheckInternal(config, { logSuccess });

    if (passed) {
      if (logSuccess) {
        SourceLogger.success('source check finished', elapsed());
      }

      task?.pass();
    } else {
      SourceLogger.error('source check finished with failures', elapsed());
      task?.fail('source check finished with failures');
    }

    return passed;
  } catch (error) {
    SourceLogger.error(
      `source check failed: ${formatErrorMessage(error)}`,
      elapsed(),
    );
    task?.fail('source check failed', { error });
    throw error;
  }
}
