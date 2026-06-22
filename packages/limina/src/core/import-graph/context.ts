import {
  type CheckerProjectParseContext,
  parseCheckerProjectConfigForContext,
} from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import type { ImportRecord } from '#core/import-analysis/runner';
import path from 'pathe';
import type ts from 'typescript';

import {
  createExtensionPattern,
  getDtsCompanionConfigPath,
  getRawReferencePaths,
  isDtsConfigPath,
  readJsonConfig,
} from '#core/tsconfig/actions';
import {
  findPackageForSpecifier,
  type ImporterInfo,
  type WorkspacePackage,
} from '#core/workspace/actions';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  toRelativePath,
} from '#utils/path';
import { formatUnknownValue } from '#utils/values';

export { isRelativeSpecifier } from '#utils/module-specifier';

export interface ProjectInfo {
  checkerPresets: CheckerProjectParseContext['checkerPresets'];
  configPath: string;
  extensions: string[];
  fileNames: string[];
  labels: string[];
  labelProblem: string | null;
  ownedFileNames: string[];
  options: ts.CompilerOptions;
  references: Set<string>;
  resolverConfigPath: string;
}

export function isDtsProjectConfig(configPath: string): boolean {
  return isDtsConfigPath(configPath);
}

export function getTypecheckConfigPath(dtsConfigPath: string): string {
  return getDtsCompanionConfigPath(dtsConfigPath);
}

export function formatImportRecordLocation(
  rootDir: string,
  importRecord: ImportRecord,
): string {
  return `${toRelativePath(rootDir, importRecord.filePath)}:${importRecord.line} (kind: ${importRecord.kind})`;
}

function readProjectGraphRules(
  config: ResolvedLiminaConfig,
  configPath: string,
): Pick<ProjectInfo, 'labels' | 'labelProblem'> {
  if (!isDtsProjectConfig(configPath)) {
    return {
      labels: [],
      labelProblem: null,
    };
  }

  const configObject = readJsonConfig(config, configPath);

  if (!Object.hasOwn(configObject, 'liminaOptions')) {
    return {
      labels: [],
      labelProblem: null,
    };
  }

  const optionsValue = configObject.liminaOptions;

  if (
    !optionsValue ||
    typeof optionsValue !== 'object' ||
    Array.isArray(optionsValue)
  ) {
    return {
      labels: [],
      labelProblem: [
        'Invalid Limina graph options:',
        `  project: ${toRelativePath(config.rootDir, configPath)}`,
        '  field: liminaOptions',
        `  value: ${formatUnknownValue(optionsValue)}`,
        '  reason: liminaOptions must be an object with an optional graphRules array.',
      ].join('\n'),
    };
  }

  const graphRules = (optionsValue as { graphRules?: unknown }).graphRules;

  if (graphRules === undefined) {
    return {
      labels: [],
      labelProblem: null,
    };
  }

  if (!Array.isArray(graphRules)) {
    return {
      labels: [],
      labelProblem: [
        'Invalid Limina graph rules:',
        `  project: ${toRelativePath(config.rootDir, configPath)}`,
        '  field: liminaOptions.graphRules',
        `  value: ${formatUnknownValue(graphRules)}`,
        '  reason: liminaOptions.graphRules must be an array of non-empty string labels.',
      ].join('\n'),
    };
  }

  const labels: string[] = [];

  for (const [index, value] of graphRules.entries()) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      return {
        labels: [],
        labelProblem: [
          'Invalid Limina graph rule label:',
          `  project: ${toRelativePath(config.rootDir, configPath)}`,
          `  field: liminaOptions.graphRules[${index}]`,
          `  value: ${formatUnknownValue(value)}`,
          '  reason: graph rule labels must be non-empty strings.',
        ].join('\n'),
      };
    }

    const label = value.trim();

    if (!labels.includes(label)) {
      labels.push(label);
    }
  }

  return {
    labels,
    labelProblem: null,
  };
}

export function formatProjectLabels(labels: readonly string[]): string {
  if (labels.length === 0) {
    return '(none)';
  }

  return labels.join(', ');
}

export function parseProject(
  config: ResolvedLiminaConfig,
  configPath: string,
  contextOrExtensions?: CheckerProjectParseContext | string[],
): ProjectInfo {
  const context = Array.isArray(contextOrExtensions)
    ? {
        checkerPresets: [] as CheckerProjectParseContext['checkerPresets'],
        extensions: contextOrExtensions,
      }
    : (contextOrExtensions ?? {
        checkerPresets: [] as CheckerProjectParseContext['checkerPresets'],
        extensions: [],
      });
  const parsed = parseCheckerProjectConfigForContext({
    configPath,
    context,
    projectRootDir: config.rootDir,
  });
  const labelInfo = readProjectGraphRules(config, configPath);
  const projectExtensions = parsed.extensions;
  const filePattern = createExtensionPattern(projectExtensions);
  const normalizedConfigPath = normalizeAbsolutePath(configPath);
  const resolverConfigPath = isDtsProjectConfig(normalizedConfigPath)
    ? getTypecheckConfigPath(normalizedConfigPath)
    : normalizedConfigPath;
  const ownedParsed =
    resolverConfigPath === normalizedConfigPath
      ? parsed
      : parseCheckerProjectConfigForContext({
          configPath: resolverConfigPath,
          context,
          projectRootDir: config.rootDir,
        });
  const normalizeFileNames = (fileNames: string[]): string[] =>
    fileNames
      .filter((fileName) => filePattern.test(fileName))
      .map(normalizeAbsolutePath);

  return {
    checkerPresets: context.checkerPresets,
    configPath: normalizedConfigPath,
    extensions: projectExtensions,
    fileNames: normalizeFileNames(parsed.fileNames),
    labels: labelInfo.labels,
    labelProblem: labelInfo.labelProblem,
    ownedFileNames: normalizeFileNames(ownedParsed.fileNames),
    options: parsed.options,
    references: new Set(getRawReferencePaths(config, configPath)),
    resolverConfigPath,
  };
}

function chooseOwningProject(projectPaths: string[]): string {
  return [...projectPaths].sort((left, right) => {
    const directoryDepthDelta =
      path.dirname(right).length - path.dirname(left).length;

    return directoryDepthDelta === 0
      ? left.localeCompare(right)
      : directoryDepthDelta;
  })[0]!;
}

export function findPackageForFile(
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

export function findImporterForFile(
  filePath: string,
  importers: ImporterInfo[],
): ImporterInfo | null {
  return (
    importers.find((importer) =>
      isPathInsideDirectory(filePath, importer.directory),
    ) ?? null
  );
}

export function shouldResolveThroughGraph(
  importer: ImporterInfo | null,
  targetPackage: WorkspacePackage | null,
): boolean {
  if (!importer || !targetPackage?.name) {
    return false;
  }

  return (
    importer.name === targetPackage.name ||
    importer.declaredWorkspaceDependencies.has(targetPackage.name)
  );
}

export function formatArtifactDependencyPolicy(
  targetPackage: WorkspacePackage,
): string {
  return targetPackage.manifest.private === true
    ? 'private workspace packages cannot be consumed from a registry, so artifact consumers should use the dependency graph export with an external task tool instead of keeping a source project reference.'
    : 'artifact consumers should use the dependency graph export with an external task tool, or consume the published production package, instead of keeping a source project reference.';
}

export function inferPackageProject(
  resolvedFilePath: string,
  workspacePackage: WorkspacePackage,
  projectPaths: string[],
): string | null {
  if (!isPathInsideDirectory(resolvedFilePath, workspacePackage.directory)) {
    return null;
  }

  return (
    projectPaths.find((projectPath) => {
      return (
        projectPath.startsWith(`${workspacePackage.directory}/`) &&
        projectPath.endsWith('/tsconfig.lib.dts.json')
      );
    }) ?? null
  );
}

export function createFileOwnerLookup(
  projects: ProjectInfo[],
): Map<string, string[]> {
  const ownerLookup = new Map<string, string[]>();

  for (const project of projects) {
    const ownerRootDir = project.options.rootDir
      ? normalizeAbsolutePath(project.options.rootDir)
      : path.dirname(project.configPath);

    for (const fileName of project.ownedFileNames) {
      if (!isPathInsideDirectory(fileName, ownerRootDir)) {
        continue;
      }

      const owners = ownerLookup.get(fileName) ?? [];

      owners.push(project.configPath);
      ownerLookup.set(fileName, owners);
    }
  }

  return ownerLookup;
}

export function findTargetProject(options: {
  fileOwnerLookup: Map<string, string[]>;
  packages: WorkspacePackage[];
  projectPaths: string[];
  resolvedFilePath: string;
  specifier: string;
}): string | null {
  const ownerProjects = options.fileOwnerLookup.get(options.resolvedFilePath);

  if (ownerProjects && ownerProjects.length > 0) {
    return chooseOwningProject(ownerProjects);
  }

  const workspacePackage = findPackageForSpecifier(
    options.specifier,
    options.packages,
  );

  if (!workspacePackage) {
    return null;
  }

  return inferPackageProject(
    options.resolvedFilePath,
    workspacePackage,
    options.projectPaths,
  );
}

export {
  clearImportAnalysisCache,
  collectImportsFromFile,
  createImportAnalysisContext,
  resolveInternalImport,
  type CreateImportAnalysisContextOptions,
  type ImportAnalysisContext,
  type ImportRecord,
  type ImportRecordKind,
} from '#core/import-analysis/runner';
