import {
  type CheckerProjectConfigCache,
  type CheckerProjectParseContext,
  normalizeExtensions,
} from '#checkers';
import { getActiveCheckers, type ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import { parseProject } from '#core/import-graph/context';
import { readJsonConfig } from '#core/tsconfig/actions';
import type { PackageOwner } from '#core/workspace/actions';
import { uniqueValues } from '#utils/collections';
import { toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { CheckCounter } from '../check-reporting/stats';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import type { AmbientDeclarationIndex } from './ambient-declarations';
import { createSourceDiagnosticFinding } from './finding-utils';
import type { SourceFinding } from './findings';
import type {
  GovernanceUnit,
  TsconfigGovernanceCollection,
} from './tsconfig-governance-types';
import { isReferenceOnlySolutionConfig } from './tsconfig-ownership-resolution';

interface CollectionOptions {
  ambientDeclarations: AmbientDeclarationIndex;
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  configPaths: string[];
  findings: SourceFinding[];
  generatedGraph: GeneratedTsconfigGraphResult;
  projectConfigCache?: CheckerProjectConfigCache;
  workspaceLookup: WorkspaceLookupIndex;
}

function getSourceGovernanceContext(
  config: ResolvedLiminaConfig,
  generatedGraph: GeneratedTsconfigGraphResult,
): CheckerProjectParseContext {
  const checkers =
    generatedGraph.checkers.length > 0
      ? generatedGraph.checkers
      : getActiveCheckers(config);

  return {
    checkerPresets: uniqueValues(checkers.map((checker) => checker.preset)),
    extensions: normalizeExtensions(
      checkers.flatMap((checker) => checker.extensions),
    ),
  };
}

function addMissingConfigOwnerFinding(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  findings: SourceFinding[];
}): void {
  const title = 'Tsconfig has no source owner';
  const reason =
    'every tsconfig*.json that governs modules must be assigned to its pnpm workspace source owner.';
  const lines = [
    `${title}:`,
    `  config: ${toRelativePath(options.config.rootDir, options.configPath)}`,
    `  reason: ${reason}`,
  ];

  options.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance,
      facts: { configPath: options.configPath, kind: 'config-missing-owner' },
      filePath: options.configPath,
      lines,
      reason,
      title,
    }),
  );
}

function getGovernedConfigOwner(options: {
  config: ResolvedLiminaConfig;
  configObject: Record<string, unknown>;
  configPath: string;
  findings: SourceFinding[];
  workspaceLookup: WorkspaceLookupIndex;
}): PackageOwner | null {
  if (isReferenceOnlySolutionConfig(options.configObject)) {
    return null;
  }

  const owner = options.workspaceLookup.findOwnerForFile(options.configPath);
  if (!owner) {
    addMissingConfigOwnerFinding(options);
    return null;
  }

  return owner;
}

function getConfigOwnerPaths(options: {
  fileOwner: PackageOwner | null;
  owner: PackageOwner;
}): string[] {
  return options.fileOwner
    ? [options.owner.packageJsonPath, options.fileOwner.packageJsonPath]
    : [options.owner.packageJsonPath];
}

function getFileOwnerLines(options: {
  config: ResolvedLiminaConfig;
  fileOwner: PackageOwner | null;
}): string[] {
  return options.fileOwner
    ? [
        `  file source owner: ${toRelativePath(options.config.rootDir, options.fileOwner.packageJsonPath)}`,
      ]
    : [];
}

function addConfigOwnerScopeFinding(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  fileName: string;
  fileOwner: PackageOwner | null;
  findings: SourceFinding[];
  owner: PackageOwner;
}): void {
  const title = 'Tsconfig source file set crosses source owner scope';
  const reason =
    'every source-owner tsconfig*.json must govern only modules owned by the same pnpm workspace source owner.';
  const ownerPaths = getConfigOwnerPaths(options);
  const lines = [
    `${title}:`,
    `  config: ${toRelativePath(options.config.rootDir, options.configPath)}`,
    `  source owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
    `  file: ${toRelativePath(options.config.rootDir, options.fileName)}`,
    ...getFileOwnerLines(options),
    `  reason: ${reason}`,
  ];

  options.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance,
      facts: {
        configPath: options.configPath,
        filePaths: [options.fileName],
        kind: 'config-owner-scope',
        packageManifestPaths: ownerPaths,
      },
      filePath: options.fileName,
      lines,
      ownerName: options.owner.name ?? undefined,
      packageJsonPath: options.owner.packageJsonPath,
      reason,
      title,
    }),
  );
}

function addUnitToFileMap(options: {
  configPath: string;
  fileName: string;
  map: Map<string, Map<string, GovernanceUnit>>;
  owner: PackageOwner;
  unitKey: string;
}): void {
  const units = options.map.get(options.fileName) ?? new Map();
  const unit = units.get(options.unitKey) ?? {
    configPaths: [],
    owner: options.owner,
  };

  unit.configPaths.push(options.configPath);
  units.set(options.unitKey, unit);
  options.map.set(options.fileName, units);
}

function hasDifferentSourceOwner(options: {
  fileOwner: PackageOwner | null;
  owner: PackageOwner;
}): boolean {
  if (!options.fileOwner) {
    return true;
  }

  return options.fileOwner.packageJsonPath !== options.owner.packageJsonPath;
}

function collectProjectFile(options: {
  base: CollectionOptions;
  collection: TsconfigGovernanceCollection;
  configPath: string;
  fileName: string;
  owner: PackageOwner;
}): void {
  options.base.checks.add();
  if (options.base.ambientDeclarations.has(options.fileName)) {
    addUnitToFileMap({
      configPath: options.configPath,
      fileName: options.fileName,
      map: options.collection.ambientConsumersByFile,
      owner: options.owner,
      unitKey: options.owner.packageJsonPath,
    });
    return;
  }

  const fileOwner = options.base.workspaceLookup.findOwnerForFile(
    options.fileName,
  );
  if (hasDifferentSourceOwner({ fileOwner, owner: options.owner })) {
    addConfigOwnerScopeFinding({
      config: options.base.config,
      configPath: options.configPath,
      fileName: options.fileName,
      fileOwner,
      findings: options.base.findings,
      owner: options.owner,
    });
  }

  addUnitToFileMap({
    configPath: options.configPath,
    fileName: options.fileName,
    map: options.collection.governanceUnitsByFile,
    owner: options.owner,
    unitKey: options.configPath,
  });
}

function collectConfig(options: {
  base: CollectionOptions;
  collection: TsconfigGovernanceCollection;
  configPath: string;
}): void {
  const configObject = readJsonConfig(options.base.config, options.configPath);
  const owner = getGovernedConfigOwner({
    config: options.base.config,
    configObject,
    configPath: options.configPath,
    findings: options.base.findings,
    workspaceLookup: options.base.workspaceLookup,
  });
  if (!owner) {
    return;
  }

  options.base.checks.add();
  const project = parseProject(
    options.base.config,
    options.configPath,
    options.collection.context,
    undefined,
    options.base.projectConfigCache,
  );
  options.collection.projectFileSetsByConfigPath.set(
    options.configPath,
    new Set(project.fileNames),
  );
  for (const fileName of project.fileNames) {
    collectProjectFile({
      base: options.base,
      collection: options.collection,
      configPath: options.configPath,
      fileName,
      owner,
    });
  }
}

export function collectTsconfigGovernance(
  options: CollectionOptions,
): TsconfigGovernanceCollection {
  const collection: TsconfigGovernanceCollection = {
    ambientConsumersByFile: new Map(),
    context: getSourceGovernanceContext(options.config, options.generatedGraph),
    governanceUnitsByFile: new Map(),
    projectFileSetsByConfigPath: new Map(),
  };

  for (const configPath of options.configPaths) {
    collectConfig({ base: options, collection, configPath });
  }

  return collection;
}
