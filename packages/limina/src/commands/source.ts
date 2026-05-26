import { createElapsedTimer } from 'logaria/helper';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ResolvedLiminaConfig } from '../config';
import type { LiminaFlowReporter } from '../flow';
import {
  collectImportsFromFile,
  getTypecheckConfigPath,
  isDtsProjectConfig,
  isRelativeSpecifier,
  parseProject,
  resolveInternalImport,
  type ImportRecord,
  type ProjectInfo,
} from '../graph-context';
import { isNodeBuiltinSpecifier } from '../graph-rules';
import { SourceLogger, clearCliScreen, formatErrorMessage } from '../logger';
import { collectSourceGraphProjectExtensions } from '../tsconfig';
import { isPathInsideDirectory, toRelativePath } from '../utils/path';
import {
  collectPackageOwners,
  collectWorkspacePackages,
  getPackageRootSpecifier,
  type PackageManifest,
  type PackageOwner,
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

function findOwnerForFile(
  filePath: string,
  owners: PackageOwner[],
): PackageOwner | null {
  return (
    owners.find((owner) => isPathInsideDirectory(filePath, owner.directory)) ??
    null
  );
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

function isDependencyAuthorized(
  manifest: PackageManifest,
  packageName: string,
): boolean {
  return Boolean(
    manifest.dependencies?.[packageName] ||
      manifest.devDependencies?.[packageName],
  );
}

function findNonAuthorizingDependencySection(
  manifest: PackageManifest,
  packageName: string,
): string | null {
  if (manifest.peerDependencies?.[packageName]) {
    return 'peerDependencies';
  }

  if (manifest.optionalDependencies?.[packageName]) {
    return 'optionalDependencies';
  }

  return null;
}

function packageImportsMatch(
  importsField: PackageManifest['imports'],
  specifier: string,
): boolean {
  if (!importsField || typeof importsField !== 'object') {
    return false;
  }

  for (const key of Object.keys(importsField)) {
    if (key === specifier) {
      return true;
    }

    const wildcardIndex = key.indexOf('*');

    if (wildcardIndex === -1) {
      continue;
    }

    const prefix = key.slice(0, wildcardIndex);
    const suffix = key.slice(wildcardIndex + 1);

    if (specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
      return true;
    }
  }

  return false;
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
  importRecord: ImportRecord;
  owner: PackageOwner;
  packageName: string;
  problems: string[];
  workspacePackage: WorkspacePackage | null;
}): void {
  const nonAuthorizingSection = findNonAuthorizingDependencySection(
    options.owner.manifest,
    options.packageName,
  );

  options.problems.push(
    [
      'Unauthorized bare package import:',
      `  package owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
      `  file: ${toRelativePath(options.config.rootDir, options.importRecord.filePath)}:${options.importRecord.line}`,
      `  imported specifier: ${options.importRecord.specifier}`,
      `  package: ${options.packageName}`,
      ...(options.workspacePackage
        ? [`  workspace package: ${options.workspacePackage.name}`]
        : []),
      ...(nonAuthorizingSection
        ? [`  found in: ${nonAuthorizingSection}`]
        : []),
      '  reason: source imports must be authorized by the nearest package.json dependencies or devDependencies.',
    ].join('\n'),
  );
}

function addPackageImportProblem(options: {
  config: ResolvedLiminaConfig;
  importRecord: ImportRecord;
  owner: PackageOwner;
  problems: string[];
  resolvedFilePath: string | null;
}): void {
  if (
    !packageImportsMatch(
      options.owner.manifest.imports,
      options.importRecord.specifier,
    )
  ) {
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

  if (
    !isPathInsideDirectory(options.resolvedFilePath, options.owner.directory)
  ) {
    options.problems.push(
      [
        'Package import escapes package owner scope:',
        `  package owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
        `  file: ${toRelativePath(options.config.rootDir, options.importRecord.filePath)}:${options.importRecord.line}`,
        `  imported specifier: ${options.importRecord.specifier}`,
        `  resolved file: ${toRelativePath(options.config.rootDir, options.resolvedFilePath)}`,
        '  reason: #... package imports must resolve within the nearest package.json owner scope.',
      ].join('\n'),
    );
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
          project.extensions,
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
      graphRoute.projectExtensionsByPath.get(projectPath),
    ),
  );
  const sourceProjectEntries = createSourceProjectEntries(config, projects);
  const packages = await collectWorkspacePackages(config);
  const packageOwners = await collectPackageOwners(config);
  const problems: string[] = [...graphRoute.problems];

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
        fileNames: parseProject(config, typecheckConfigPath, project.extensions)
          .fileNames,
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
      )) {
        const resolvedFilePath = resolveInternalImport(
          importRecord.specifier,
          filePath,
          project.options,
          project.extensions,
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

        const packageName = getPackageRootSpecifier(importRecord.specifier);

        if (owner.name === packageName) {
          continue;
        }

        const workspacePackage =
          packages.find((candidate) => candidate.name === packageName) ?? null;

        if (isDependencyAuthorized(owner.manifest, packageName)) {
          continue;
        }

        addPackageImportAuthorizationProblem({
          config,
          importRecord,
          owner,
          packageName,
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
