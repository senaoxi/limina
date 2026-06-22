import {
  type CheckerProjectParseContext,
  normalizeExtensions,
} from '#checkers';
import { getActiveCheckers, type ResolvedLiminaConfig } from '#config/runner';
import type { LiminaCore } from '#core';
import {
  collectGeneratedSourceConfigPaths,
  type GeneratedTsconfigGraphResult,
} from '#core/build-graph/runner';
import {
  collectImportsFromFile,
  formatImportRecordLocation,
  getTypecheckConfigPath,
  type ImportRecord,
  isDtsProjectConfig,
  parseProject,
  type ProjectInfo,
  resolveInternalImport,
} from '#core/import-graph/context';
import {
  getRawReferencePaths,
  isOrdinaryTypecheckConfigPath,
  readJsonConfig,
} from '#core/tsconfig/actions';
import {
  getPackageRootSpecifier,
  type PackageOwner,
  type WorkspacePackage,
} from '#core/workspace/actions';
import { uniqueSortedStrings, uniqueValues } from '#utils/collections';
import {
  isBarePackageSpecifier,
  isPackageImportSpecifier,
  isRelativeSpecifier,
  isUrlOrDataOrFileSpecifier,
  isVirtualModuleSpecifier,
} from '#utils/module-specifier';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  normalizeSlashes,
  toRelativePath,
} from '#utils/path';
import { existsSync } from 'node:fs';
import path from 'pathe';
import rawPicomatch from 'picomatch';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { LiminaCheckRunTaskStats } from '../check-reporting/run-recorder';
import {
  type CheckCounter,
  createCheckCounter,
  createCheckItemAccumulator,
} from '../check-reporting/stats';
import {
  createWorkspaceDependencyKey,
  findPackageImportMatch,
  isDependencyAuthorized,
  type WorkspaceDependencyDeclaration,
} from '../core/packages/authority';
import {
  classifyResolvedPackageTarget,
  findNearestPackageScopeInfo,
  findOwnerForFile,
  type NearestPackageInfo,
  type ResolvedPackageTarget,
} from '../core/packages/owners';
import type { TaskProgressReporter } from '../execution/progress';
import type { LiminaFlowReporter } from '../flow';
import { isNodeBuiltinSpecifier } from '../graph-check/rules';
import { SourceLogger } from '../logger';
import { type LiminaPreflightManager, resolvePreflight } from '../preflight';
import {
  collectKnipSourceIssues,
  type KnipCliRunner,
  type KnipOwnerProject,
  type KnipSourceIssues,
} from './knip';
import {
  collectSourceKnipWorkspaceConfigs,
  createKnipSourceAnalysisGroups,
} from './knip-routing';
import {
  collectManifestSourceEntryPatterns,
  collectOwnerSourceModuleSets,
  collectUnusedDependencyIgnore,
  collectUnusedModuleConfig,
  createOwnerSourceFileKey,
  createPackageDependencyIssueKey,
  type OwnerSourceModuleSet,
} from './knip-unused';
import {
  formatSourceCheckHumanReport,
  SOURCE_ISSUE_CODES,
  type SourceCheckIssue,
  type SourceIssueReportOptions,
  type SourceStructuredIssue,
} from './report';
import {
  type LiminaCheckIssue,
  writeCompletedSourceIssueSnapshot,
} from './snapshot';
import {
  isInvalidWorkspacePattern,
  normalizeWorkspacePattern,
} from './workspace-patterns';

export interface RunSourceCheckOptions {
  clearScreen?: boolean;
  core?: LiminaCore;
  deferSnapshot?: boolean;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  generatedGraphProvider?: () => Promise<GeneratedTsconfigGraphResult>;
  issues?: LiminaCheckIssue[];
  knipRunner?: KnipCliRunner;
  legacyProblems?: string[];
  onStats?: (stats: LiminaCheckRunTaskStats) => void;
  preflight?: LiminaPreflightManager;
  progress?: TaskProgressReporter;
  report?: SourceIssueReportOptions;
  sourceIssues?: SourceCheckIssue[];
}

const SOURCE_CHECK_ITEM_NAMES = [
  'source graph routes',
  'tsconfig governance',
  'knip source usage',
  'source project ownership',
  'source import authority',
] as const;

interface SourceProjectEntry {
  fileNames: string[];
  project: ProjectInfo;
}

interface TsconfigOwnershipResolution {
  matchedOwnerConfigPaths: string[];
  searchedTsconfigPaths: string[];
  status: 'matched' | 'missing' | 'multiple' | 'unmatched';
  tsconfigPath: string | null;
}

const picomatch = rawPicomatch as unknown as (
  pattern: string,
  options?: { dot?: boolean; posixSlashes?: boolean },
) => (value: string) => boolean;

interface CompiledImportAuthorityAllowRule {
  fileMatchers: ((value: string) => boolean)[];
  ownerIdentity?: string;
  packageMatchers: ((value: string) => boolean)[];
  reason: string;
  specifierMatchers: ((value: string) => boolean)[];
}

function addProjectOwnerProblems(options: {
  checks: CheckCounter;
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
    options.checks.add();
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
        'Source file has no source owner:',
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
        '  reason: every source file checked by Limina must be governed by a pnpm workspace source owner.',
      ].join('\n'),
    );
  }

  if (ownerPaths.size <= 1) {
    return;
  }

  options.problems.push(
    [
      'Tsconfig source file set mixes source owners:',
      `  ${options.role}: ${toRelativePath(options.config.rootDir, options.configPath)}`,
      '  source owners:',
      ...[...ownerPaths.values()].map(
        (owner) =>
          `    - ${toRelativePath(options.config.rootDir, owner.packageJsonPath)}`,
      ),
      '  reason: non-aggregator tsconfig leaves and their companion typecheck configs must stay within one pnpm workspace source owner scope.',
    ].join('\n'),
  );
}

function addRelativeImportOwnerProblem(options: {
  config: ResolvedLiminaConfig;
  importRecord: ImportRecord;
  owner: PackageOwner;
  problems: string[];
  resolvedFilePath: string;
  sourcePackageScope: NearestPackageInfo | null;
  targetPackageScope: NearestPackageInfo | null;
}): void {
  options.problems.push(
    [
      'Relative import escapes package scope:',
      `  source owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
      ...(options.sourcePackageScope
        ? [
            `  package scope: ${toRelativePath(options.config.rootDir, options.sourcePackageScope.packageJsonPath)}`,
          ]
        : []),
      `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
      `  imported specifier: ${options.importRecord.specifier}`,
      `  resolved file: ${toRelativePath(options.config.rootDir, options.resolvedFilePath)}`,
      ...(options.targetPackageScope
        ? [
            `  target package scope: ${toRelativePath(options.config.rootDir, options.targetPackageScope.packageJsonPath)}`,
          ]
        : []),
      '  reason: relative source imports must not cross the nearest package.json package boundary.',
    ].join('\n'),
  );
}

function addPackageImportAuthorizationProblem(options: {
  authorityManifestPaths: string[];
  config: ResolvedLiminaConfig;
  dependencySpecifier?: string;
  importRecord: ImportRecord;
  owner: PackageOwner;
  packageName: string;
  problems: string[];
  workspacePackage: WorkspacePackage | null;
}): void {
  const fix = formatPackageImportAuthorizationFix(options);

  options.problems.push(
    [
      'Unauthorized bare package import:',
      `  source owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
      `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
      `  imported specifier: ${options.importRecord.specifier}`,
      `  package: ${options.packageName}`,
      ...(options.dependencySpecifier
        ? [`  resolved dependency specifier: ${options.dependencySpecifier}`]
        : []),
      ...(options.workspacePackage?.name
        ? [`  workspace package: ${options.workspacePackage.name}`]
        : []),
      '  dependency authority manifests:',
      ...options.authorityManifestPaths.map(
        (manifestPath) =>
          `    - ${toRelativePath(options.config.rootDir, manifestPath)}`,
      ),
      '  reason: source imports must be declared by the nearest pnpm workspace source owner, by the workspace root manifest when a matching source.importAuthority.allow package rule makes it a candidate, or by an explicit source.importAuthority.allow specifier rule.',
      `  fix: ${fix}`,
    ].join('\n'),
  );
}

function formatPackageImportAuthorizationFix(options: {
  authorityManifestPaths: string[];
  config: ResolvedLiminaConfig;
  dependencySpecifier?: string;
  importRecord: ImportRecord;
  owner: PackageOwner;
  packageName: string;
  workspacePackage: WorkspacePackage | null;
}): string {
  const ownerManifestPath = toRelativePath(
    options.config.rootDir,
    options.owner.packageJsonPath,
  );
  const rootManifestPath = options.authorityManifestPaths.find(
    (manifestPath) => manifestPath !== options.owner.packageJsonPath,
  );
  const rootManifestFix = rootManifestPath
    ? ` Because a source.importAuthority.allow package rule matches this import, declaring "${options.packageName}" in ${toRelativePath(options.config.rootDir, rootManifestPath)} dependencies, devDependencies, peerDependencies, or optionalDependencies is also accepted.`
    : '';
  const typeDeclarationFix =
    options.dependencySpecifier?.startsWith('@types/') &&
    options.dependencySpecifier !== options.packageName
      ? ` "${options.dependencySpecifier}" only supplies declarations and does not authorize "${options.packageName}".`
      : '';
  const explicitAuthorityFix = ` If "${options.packageName}" is supplied by a runtime, template, or alias instead of a dependency manifest, add a source.importAuthority.allow specifier rule for this import with a reason.`;
  return [
    `Declare "${options.packageName}" in ${ownerManifestPath} dependencies, devDependencies, peerDependencies, or optionalDependencies.`,
    rootManifestFix,
    explicitAuthorityFix,
    typeDeclarationFix,
  ]
    .filter(Boolean)
    .join(' ');
}

function getWorkspacePackageJsonPath(
  workspacePackage: WorkspacePackage,
): string {
  return normalizeAbsolutePath(
    path.join(workspacePackage.directory, 'package.json'),
  );
}

function findWorkspaceRootPackage(options: {
  config: ResolvedLiminaConfig;
  packages: WorkspacePackage[];
}): WorkspacePackage | null {
  return (
    options.packages.find(
      (workspacePackage) =>
        normalizeAbsolutePath(workspacePackage.directory) ===
        normalizeAbsolutePath(options.config.rootDir),
    ) ?? null
  );
}

function getDependencyAuthorityManifestPaths(options: {
  config: ResolvedLiminaConfig;
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  packageName: string;
  rootPackage: WorkspacePackage | null;
}): string[] {
  const manifestPaths = [options.owner.packageJsonPath];

  if (
    options.rootPackage &&
    options.rootPackage.directory !== options.owner.directory &&
    isRootManifestDependencyAuthorityCandidate({
      config: options.config,
      importAuthorityAllowRules: options.importAuthorityAllowRules,
      importRecord: options.importRecord,
      owner: options.owner,
      packageName: options.packageName,
    })
  ) {
    manifestPaths.push(getWorkspacePackageJsonPath(options.rootPackage));
  }

  return manifestPaths;
}

function isDependencyAuthorizedBySourceAuthority(options: {
  config: ResolvedLiminaConfig;
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  packageName: string;
  rootPackage: WorkspacePackage | null;
}): boolean {
  if (isDependencyAuthorized(options.owner.manifest, options.packageName)) {
    return true;
  }

  if (
    options.rootPackage &&
    options.rootPackage.directory !== options.owner.directory &&
    isRootManifestDependencyAuthorityCandidate({
      config: options.config,
      importAuthorityAllowRules: options.importAuthorityAllowRules,
      importRecord: options.importRecord,
      owner: options.owner,
      packageName: options.packageName,
    }) &&
    isDependencyAuthorized(options.rootPackage.manifest, options.packageName)
  ) {
    return true;
  }

  return isImportAuthorizedByExplicitAuthority({
    config: options.config,
    importRecord: options.importRecord,
    owner: options.owner,
    rules: options.importAuthorityAllowRules,
  });
}

function getPackageNameForAuthorization(options: {
  importRecord: ImportRecord;
  resolvedPackageName?: string;
}): string {
  const fallbackPackageName = getPackageRootSpecifier(
    options.importRecord.specifier,
  );

  if (
    options.resolvedPackageName?.startsWith('@types/') &&
    fallbackPackageName !== options.resolvedPackageName
  ) {
    return fallbackPackageName;
  }

  return options.resolvedPackageName ?? fallbackPackageName;
}

function createValueMatcher(pattern: string): (value: string) => boolean {
  if (/[*?[\]{}()!+]/u.test(pattern)) {
    return picomatch(pattern, {
      dot: true,
      posixSlashes: true,
    });
  }

  return (value) => value === pattern;
}

function getSourceOwnerIdentity(options: {
  config: ResolvedLiminaConfig;
  owner: PackageOwner;
}): string {
  return (
    options.owner.name ??
    normalizeSlashes(
      toRelativePath(options.config.rootDir, options.owner.directory),
    )
  );
}

function collectImportAuthorityAllowRules(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  problems: string[];
}): CompiledImportAuthorityAllowRule[] {
  const rawRules = options.config.source?.importAuthority?.allow;

  if (rawRules === undefined) {
    return [];
  }

  const rules: CompiledImportAuthorityAllowRule[] = [];

  for (const [index, rule] of rawRules.entries()) {
    options.checks.add();
    const field = `source.importAuthority.allow[${index}]`;
    const files = rule.files
      .map((file) => normalizeWorkspacePattern(file))
      .filter((file) => file.length > 0);
    const invalidFile = files.find(isInvalidWorkspacePattern);

    if (files.length === 0 || invalidFile) {
      options.problems.push(
        [
          'Invalid source import authority config:',
          `  field: ${field}.files`,
          ...(invalidFile ? [`  file: ${invalidFile}`] : []),
          '  reason: files must be positive workspace-root-relative globs inside the workspace root.',
        ].join('\n'),
      );
      continue;
    }

    const packages = rule.packages?.map((value) => value.trim()) ?? [];
    const specifiers = rule.specifiers?.map((value) => value.trim()) ?? [];

    rules.push({
      fileMatchers: files.map((file) =>
        picomatch(file, {
          dot: true,
          posixSlashes: true,
        }),
      ),
      ...(rule.owner ? { ownerIdentity: rule.owner.trim() } : {}),
      packageMatchers: packages.map(createValueMatcher),
      reason: rule.reason.trim(),
      specifierMatchers: specifiers.map(createValueMatcher),
    });
  }

  return rules;
}

function hasImportAuthorityPackageRules(
  rules: CompiledImportAuthorityAllowRule[],
): boolean {
  return rules.some((rule) => rule.packageMatchers.length > 0);
}

function addImportAuthorityRootManifestConfigProblems(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
  problems: string[];
}): void {
  options.checks.add();

  if (!hasImportAuthorityPackageRules(options.importAuthorityAllowRules)) {
    return;
  }

  const rootPackageJsonPath = path.join(options.config.rootDir, 'package.json');

  if (existsSync(rootPackageJsonPath)) {
    return;
  }

  options.problems.push(
    [
      'Invalid source import authority config:',
      '  field: source.importAuthority.allow[].packages',
      '  reason: package allow rules enable workspace root package.json as a dependency authority manifest, but no package.json exists at the workspace root.',
      '  fix: create a workspace root package.json or remove package entries from source.importAuthority.allow rules.',
    ].join('\n'),
  );
}

function getImportAuthorityRuleContext(options: {
  config: ResolvedLiminaConfig;
  importRecord: ImportRecord;
  owner: PackageOwner;
}): {
  filePath: string;
  ownerIdentity: string;
} {
  return {
    filePath: normalizeSlashes(
      toRelativePath(options.config.rootDir, options.importRecord.filePath),
    ),
    ownerIdentity: getSourceOwnerIdentity({
      config: options.config,
      owner: options.owner,
    }),
  };
}

function isImportAuthorityRuleInScope(
  rule: CompiledImportAuthorityAllowRule,
  context: {
    filePath: string;
    ownerIdentity: string;
  },
): boolean {
  if (rule.ownerIdentity && rule.ownerIdentity !== context.ownerIdentity) {
    return false;
  }

  return rule.fileMatchers.some((matches) => matches(context.filePath));
}

function isRootManifestDependencyAuthorityCandidate(options: {
  config: ResolvedLiminaConfig;
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  packageName: string;
}): boolean {
  if (options.importAuthorityAllowRules.length === 0) {
    return false;
  }

  const context = getImportAuthorityRuleContext({
    config: options.config,
    importRecord: options.importRecord,
    owner: options.owner,
  });

  return options.importAuthorityAllowRules.some((rule) => {
    return (
      isImportAuthorityRuleInScope(rule, context) &&
      rule.packageMatchers.some((matches) => matches(options.packageName))
    );
  });
}

function isImportAuthorizedByExplicitAuthority(options: {
  config: ResolvedLiminaConfig;
  importRecord: ImportRecord;
  owner: PackageOwner;
  rules: CompiledImportAuthorityAllowRule[];
}): boolean {
  if (options.rules.length === 0) {
    return false;
  }

  const context = getImportAuthorityRuleContext({
    config: options.config,
    importRecord: options.importRecord,
    owner: options.owner,
  });

  return options.rules.some((rule) => {
    return (
      isImportAuthorityRuleInScope(rule, context) &&
      rule.specifierMatchers.some((matches) =>
        matches(options.importRecord.specifier),
      )
    );
  });
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
      `  source owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
      `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
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
      'Package import resolves to another source owner:',
      `  source owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
      `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
      `  imported specifier: ${options.importRecord.specifier}`,
      `  target source owner: ${toRelativePath(options.config.rootDir, options.targetOwner.packageJsonPath)}`,
      ...(options.workspacePackage?.name
        ? [`  workspace package: ${options.workspacePackage.name}`]
        : []),
      '  reason: #... package imports must not resolve to modules governed by another source owner.',
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
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
  rootPackage: WorkspacePackage | null;
}): void {
  const match = findPackageImportMatch(
    options.owner.manifest.imports,
    options.importRecord.specifier,
  );

  if (!match) {
    options.problems.push(
      [
        'Unauthorized package import specifier:',
        `  source owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
        `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
        `  imported specifier: ${options.importRecord.specifier}`,
        '  reason: #... package imports must match the source owner package.json imports field.',
      ].join('\n'),
    );
    return;
  }

  if (!options.resolvedFilePath) {
    options.problems.push(
      [
        'Unresolved package import specifier:',
        `  source owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
        `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
        `  imported specifier: ${options.importRecord.specifier}`,
        '  reason: matched #... package imports must resolve to a file within the same source owner scope.',
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

    const packageName = getPackageNameForAuthorization({
      importRecord: options.importRecord,
      resolvedPackageName: target.packageInfo.name,
    });

    if (
      isDependencyAuthorizedBySourceAuthority({
        config: options.config,
        importAuthorityAllowRules: options.importAuthorityAllowRules,
        importRecord: options.importRecord,
        owner: options.owner,
        packageName,
        rootPackage: options.rootPackage,
      })
    ) {
      return;
    }

    addPackageImportAuthorizationProblem({
      authorityManifestPaths: getDependencyAuthorityManifestPaths({
        config: options.config,
        importAuthorityAllowRules: options.importAuthorityAllowRules,
        importRecord: options.importRecord,
        owner: options.owner,
        packageName,
        rootPackage: options.rootPackage,
      }),
      config: options.config,
      dependencySpecifier: target.packageInfo.name,
      importRecord: options.importRecord,
      owner: options.owner,
      packageName,
      problems: options.problems,
      workspacePackage: null,
    });
    return;
  }

  options.problems.push(
    [
      'Package import resolves outside source ownership:',
      `  source owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
      `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
      `  imported specifier: ${options.importRecord.specifier}`,
      `  resolved file: ${toRelativePath(options.config.rootDir, options.resolvedFilePath)}`,
      '  reason: #... package imports must resolve to the current source owner or to a named artifact package dependency.',
    ].join('\n'),
  );
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
  generatedGraph?: GeneratedTsconfigGraphResult,
): CheckerProjectParseContext {
  const checkers = generatedGraph?.checkers ?? getActiveCheckers(config);

  return {
    checkerPresets: uniqueValues(checkers.map((checker) => checker.preset)),
    extensions: normalizeExtensions(
      checkers.flatMap((checker) => checker.extensions),
    ),
  };
}

function collectBareTsconfigPathCandidates(options: {
  filePath: string;
  rootDir: string;
}): string[] {
  const candidates: string[] = [];
  let currentDir = normalizeAbsolutePath(path.dirname(options.filePath));
  const rootDir = normalizeAbsolutePath(options.rootDir);

  while (isPathInsideDirectory(currentDir, rootDir)) {
    const candidate = normalizeAbsolutePath(
      path.join(currentDir, 'tsconfig.json'),
    );

    if (existsSync(candidate)) {
      candidates.push(candidate);
    }

    if (currentDir === rootDir) {
      break;
    }

    const parentDir = normalizeAbsolutePath(path.dirname(currentDir));

    if (parentDir === currentDir) {
      break;
    }

    currentDir = parentDir;
  }

  return candidates;
}

function collectReachableOrdinaryTypecheckConfigPaths(options: {
  config: ResolvedLiminaConfig;
  rootConfigPath: string;
}): string[] {
  const queue = getRawReferencePaths(options.config, options.rootConfigPath);
  const reachablePaths: string[] = [];
  const seen = new Set<string>();

  for (const configPath of queue) {
    const normalizedConfigPath = normalizeAbsolutePath(configPath);

    if (seen.has(normalizedConfigPath)) {
      continue;
    }

    seen.add(normalizedConfigPath);

    if (
      !existsSync(normalizedConfigPath) ||
      !isOrdinaryTypecheckConfigPath(normalizedConfigPath)
    ) {
      continue;
    }

    reachablePaths.push(normalizedConfigPath);
    queue.push(...getRawReferencePaths(options.config, normalizedConfigPath));
  }

  return reachablePaths;
}

function collectTsconfigOwnershipMatches(options: {
  config: ResolvedLiminaConfig;
  fileName: string;
  getProjectFileSet: (configPath: string) => Set<string>;
  rootConfigPath: string;
}): string[] {
  if (options.getProjectFileSet(options.rootConfigPath).has(options.fileName)) {
    return [options.rootConfigPath];
  }

  return collectReachableOrdinaryTypecheckConfigPaths({
    config: options.config,
    rootConfigPath: options.rootConfigPath,
  }).filter((configPath) =>
    options.getProjectFileSet(configPath).has(options.fileName),
  );
}

function resolveTsconfigOwnership(options: {
  config: ResolvedLiminaConfig;
  fileName: string;
  getProjectFileSet: (configPath: string) => Set<string>;
}): TsconfigOwnershipResolution {
  const candidatePaths = collectBareTsconfigPathCandidates({
    filePath: options.fileName,
    rootDir: options.config.rootDir,
  });
  const searchedTsconfigPaths: string[] = [];

  if (candidatePaths.length === 0) {
    return {
      matchedOwnerConfigPaths: [],
      searchedTsconfigPaths,
      status: 'missing',
      tsconfigPath: null,
    };
  }

  for (const candidatePath of candidatePaths) {
    searchedTsconfigPaths.push(candidatePath);

    const matchedOwnerConfigPaths = collectTsconfigOwnershipMatches({
      config: options.config,
      fileName: options.fileName,
      getProjectFileSet: options.getProjectFileSet,
      rootConfigPath: candidatePath,
    });

    if (matchedOwnerConfigPaths.length === 1) {
      return {
        matchedOwnerConfigPaths,
        searchedTsconfigPaths,
        status: 'matched',
        tsconfigPath: candidatePath,
      };
    }

    if (matchedOwnerConfigPaths.length > 1) {
      return {
        matchedOwnerConfigPaths,
        searchedTsconfigPaths,
        status: 'multiple',
        tsconfigPath: candidatePath,
      };
    }
  }

  return {
    matchedOwnerConfigPaths: [],
    searchedTsconfigPaths,
    status: 'unmatched',
    tsconfigPath: searchedTsconfigPaths.at(-1) ?? null,
  };
}

function formatConfigPathList(
  config: ResolvedLiminaConfig,
  configPaths: string[],
): string[] {
  if (configPaths.length === 0) {
    return ['    (none)'];
  }

  return configPaths
    .sort((left, right) =>
      toRelativePath(config.rootDir, left).localeCompare(
        toRelativePath(config.rootDir, right),
      ),
    )
    .map((configPath) => `    - ${toRelativePath(config.rootDir, configPath)}`);
}

function addNearestTsconfigOwnershipProblem(options: {
  config: ResolvedLiminaConfig;
  fileName: string;
  matchedOwnerConfigPaths: string[];
  problems: string[];
  reason: string;
  searchedTsconfigPaths: string[];
  tsconfigPath: string | null;
}): void {
  options.problems.push(
    [
      'Tsconfig search cannot determine module owner:',
      `  file: ${toRelativePath(options.config.rootDir, options.fileName)}`,
      ...(options.tsconfigPath
        ? [
            `  resolver tsconfig: ${toRelativePath(options.config.rootDir, options.tsconfigPath)}`,
          ]
        : []),
      '  searched tsconfigs:',
      ...formatConfigPathList(options.config, options.searchedTsconfigPaths),
      '  matched owner tsconfigs:',
      ...formatConfigPathList(options.config, options.matchedOwnerConfigPaths),
      `  reason: ${options.reason}`,
      '  fix: make one tsconfig.json between the module directory and workspace root include the module, or make its ordinary typecheck references reach exactly one owner tsconfig.',
    ].join('\n'),
  );
}

async function addTsconfigGovernanceProblems(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  configPaths: string[];
  generatedGraph: GeneratedTsconfigGraphResult;
  owners: PackageOwner[];
  problems: string[];
}): Promise<void> {
  const configPaths = options.configPaths;
  const context = getSourceGovernanceContext(
    options.config,
    options.generatedGraph,
  );
  const governanceUnitsByFile = new Map<
    string,
    Map<string, { configPaths: string[]; owner: PackageOwner }>
  >();
  const projectFileSetsByConfigPath = new Map<string, Set<string>>();
  const getProjectFileSet = (configPath: string): Set<string> => {
    const normalizedConfigPath = normalizeAbsolutePath(configPath);
    const cached = projectFileSetsByConfigPath.get(normalizedConfigPath);

    if (cached) {
      return cached;
    }

    const fileSet = new Set(
      parseProject(options.config, normalizedConfigPath, context).fileNames,
    );

    projectFileSetsByConfigPath.set(normalizedConfigPath, fileSet);
    return fileSet;
  };

  for (const configPath of configPaths) {
    const configObject = readJsonConfig(options.config, configPath);

    if (shouldSkipGovernedTsconfig(configObject)) {
      continue;
    }

    options.checks.add();

    const owner = findOwnerForFile(configPath, options.owners);

    if (!owner) {
      options.problems.push(
        [
          'Tsconfig has no source owner:',
          `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
          '  reason: every tsconfig*.json that governs modules must be assigned to its pnpm workspace source owner.',
        ].join('\n'),
      );
      continue;
    }

    const project = parseProject(options.config, configPath, context);
    const unitKey = configPath;
    projectFileSetsByConfigPath.set(configPath, new Set(project.fileNames));

    for (const fileName of project.fileNames) {
      options.checks.add();
      const fileOwner = findOwnerForFile(fileName, options.owners);

      if (fileOwner?.packageJsonPath !== owner.packageJsonPath) {
        options.problems.push(
          [
            'Tsconfig source file set crosses source owner scope:',
            `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
            `  source owner: ${toRelativePath(options.config.rootDir, owner.packageJsonPath)}`,
            `  file: ${toRelativePath(options.config.rootDir, fileName)}`,
            ...(fileOwner
              ? [
                  `  file source owner: ${toRelativePath(options.config.rootDir, fileOwner.packageJsonPath)}`,
                ]
              : []),
            '  reason: every source-owner tsconfig*.json must govern only modules owned by the same pnpm workspace source owner.',
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
    options.checks.add();
    const ownershipResolution = resolveTsconfigOwnership({
      config: options.config,
      fileName,
      getProjectFileSet,
    });

    if (ownershipResolution.status === 'missing') {
      addNearestTsconfigOwnershipProblem({
        config: options.config,
        fileName,
        matchedOwnerConfigPaths: ownershipResolution.matchedOwnerConfigPaths,
        problems: options.problems,
        reason:
          'no tsconfig.json was found between the module directory and the workspace root.',
        searchedTsconfigPaths: ownershipResolution.searchedTsconfigPaths,
        tsconfigPath: ownershipResolution.tsconfigPath,
      });
    } else if (ownershipResolution.status !== 'matched') {
      addNearestTsconfigOwnershipProblem({
        config: options.config,
        fileName,
        matchedOwnerConfigPaths: ownershipResolution.matchedOwnerConfigPaths,
        problems: options.problems,
        reason:
          ownershipResolution.status === 'unmatched'
            ? 'no tsconfig.json between the module directory and workspace root includes the module or reaches one ordinary typecheck config that includes it.'
            : 'the first matching tsconfig.json reaches multiple ordinary typecheck configs that include the module.',
        searchedTsconfigPaths: ownershipResolution.searchedTsconfigPaths,
        tsconfigPath: ownershipResolution.tsconfigPath,
      });
    }

    if (governanceUnits.size <= 1) {
      continue;
    }

    const uniqueOwners = uniqueValues(
      [...governanceUnits.values()].map((unit) => unit.owner.packageJsonPath),
    );

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
        'Source module belongs to multiple source owners:',
        `  file: ${toRelativePath(options.config.rootDir, fileName)}`,
        '  source owners:',
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
        '  reason: source ownership prohibits overlap between module sets governed by different pnpm workspace source owners.',
      ].join('\n'),
    );
  }
}

function createKnipOwnerProjects(options: {
  entryPatternsByOwnerName: Map<string, string[]>;
  ignoredModuleKeys: Set<string>;
  includeFiles: boolean;
  ownerModuleSets: OwnerSourceModuleSet[];
}): KnipOwnerProject[] {
  return options.ownerModuleSets.map((moduleSet) => ({
    directory: moduleSet.owner.directory,
    entryFiles: uniqueSortedStrings([
      ...(options.entryPatternsByOwnerName.get(
        moduleSet.owner.name as string,
      ) ?? []),
      ...collectManifestSourceEntryPatterns(moduleSet),
    ]),
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
  checks: CheckCounter;
  declarations: WorkspaceDependencyDeclaration[];
  ignoredDependencies: Set<string>;
  issues: SourceCheckIssue[];
  knipIssues: KnipSourceIssues;
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
    options.checks.add();
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

    options.issues.push({
      code: SOURCE_ISSUE_CODES.unusedWorkspaceDependency,
      dependencyName: declaration.dependencyName,
      ownerName: declaration.importer.name,
      packageJsonPath: declaration.packageJsonPath,
      sectionName: declaration.sectionName,
      specifier: declaration.specifier,
    });
  }
}

function addUnusedModuleProblems(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  ignoredModuleKeys: Set<string>;
  issues: SourceCheckIssue[];
  knipIssues: KnipSourceIssues;
  ownerModuleSets: OwnerSourceModuleSet[];
}): void {
  const moduleSetByFilePath = new Map<string, OwnerSourceModuleSet>();
  const reportedKeys = new Set<string>();

  for (const moduleSet of options.ownerModuleSets) {
    if (!moduleSet.checkUnusedFiles) {
      continue;
    }

    for (const filePath of moduleSet.files) {
      options.checks.add();
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

    options.issues.push({
      code: SOURCE_ISSUE_CODES.unusedModule,
      filePath,
      ownerDirectory: moduleSet.owner.directory,
      ownerName: moduleSet.owner.name,
      packageJsonPath: moduleSet.owner.packageJsonPath,
    });
  }
}

async function addKnipBackedSourceProblems(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  generatedGraph: GeneratedTsconfigGraphResult;
  knipRunner?: KnipCliRunner;
  ownerModuleSets: OwnerSourceModuleSet[];
  problems: string[];
  sourceIssues: SourceCheckIssue[];
  workspaceDependencyDeclarations: WorkspaceDependencyDeclaration[];
  workspacePackages: WorkspacePackage[];
}): Promise<void> {
  if (options.config.source?.knip === false) {
    return;
  }

  const declarations = options.workspaceDependencyDeclarations;
  const knipWorkspaceConfigs = collectSourceKnipWorkspaceConfigs({
    config: options.config,
    problems: options.problems,
    workspacePackages: options.workspacePackages,
  });

  for (const diagnostic of options.generatedGraph.generatedKnipDiagnostics) {
    options.checks.add();
    options.problems.push(
      [
        'Unsupported package build script for generated Knip tsconfig:',
        `  package: ${diagnostic.packageName ?? '<unnamed>'}`,
        `  package manifest: ${toRelativePath(options.config.rootDir, diagnostic.packageJsonPath)}`,
        ...(diagnostic.scriptName
          ? [`  script: ${diagnostic.scriptName}`]
          : []),
        ...(diagnostic.command ? [`  command: ${diagnostic.command}`] : []),
        `  reason: ${diagnostic.reason}`,
      ].join('\n'),
    );
  }

  const ignoredDependencies = collectUnusedDependencyIgnore({
    declarations,
    knipWorkspaceConfigs,
    problems: options.problems,
    workspacePackages: options.workspacePackages,
  });
  const unusedModuleConfig = collectUnusedModuleConfig({
    config: options.config,
    knipWorkspaceConfigs,
    ownerModuleSets: options.ownerModuleSets,
    problems: options.problems,
  });
  const requiredWorkspaceNames = new Set([
    ...declarations.map((declaration) => declaration.importer.name),
    ...options.ownerModuleSets.flatMap((moduleSet) =>
      moduleSet.owner.name ? [moduleSet.owner.name] : [],
    ),
    ...knipWorkspaceConfigs.keys(),
  ]);
  const analysisGroups = createKnipSourceAnalysisGroups({
    config: options.config,
    generatedGraph: options.generatedGraph,
    requiredWorkspaceNames,
    workspacePackages: options.workspacePackages,
  });

  if (options.problems.length > 0) {
    return;
  }

  const includeFiles = options.ownerModuleSets.length > 0;
  const needsDependencyAnalysis =
    options.workspacePackages.length > 0 && declarations.length > 0;
  const ownerProjects = createKnipOwnerProjects({
    entryPatternsByOwnerName: unusedModuleConfig.entryPatternsByOwnerName,
    ignoredModuleKeys: unusedModuleConfig.ignoredKeys,
    includeFiles,
    ownerModuleSets: options.ownerModuleSets,
  });

  if (!needsDependencyAnalysis && !includeFiles) {
    return;
  }

  const knipIssues = await collectKnipSourceIssues({
    analysisGroups,
    config: options.config,
    ignoredKeys: ignoredDependencies,
    includeFiles,
    knipRunner: options.knipRunner,
    ownerProjects: needsDependencyAnalysis || includeFiles ? ownerProjects : [],
    workspacePackages: options.workspacePackages,
  });

  addUnusedDependencyProblems({
    checks: options.checks,
    declarations,
    ignoredDependencies,
    issues: options.sourceIssues,
    knipIssues,
  });

  if (includeFiles) {
    addUnusedModuleProblems({
      checks: options.checks,
      config: options.config,
      ignoredModuleKeys: unusedModuleConfig.ignoredKeys,
      issues: options.sourceIssues,
      knipIssues,
      ownerModuleSets: options.ownerModuleSets,
    });
  }
}

async function createSourceProjectEntries(
  core: LiminaCore,
  projects: ProjectInfo[],
): Promise<SourceProjectEntry[]> {
  return Promise.all(
    projects
      .filter((project) => isDtsProjectConfig(project.configPath))
      .map(async (project) => {
        const typecheckConfigPath = getTypecheckConfigPath(project.configPath);
        const fileNames = new Set(project.fileNames);

        if (existsSync(typecheckConfigPath)) {
          for (const fileName of (
            await core.tsconfig.getProject(typecheckConfigPath, project)
          ).fileNames) {
            fileNames.add(fileName);
          }
        }

        return {
          fileNames: [...fileNames].sort(),
          project,
        };
      }),
  );
}

async function addSourceProjectOwnerProblems(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  core: LiminaCore;
  owners: PackageOwner[];
  problems: string[];
  projects: ProjectInfo[];
}): Promise<void> {
  for (const project of options.projects) {
    if (project.labelProblem) {
      options.problems.push(project.labelProblem);
    }

    if (!isDtsProjectConfig(project.configPath)) {
      continue;
    }

    addProjectOwnerProblems({
      checks: options.checks,
      config: options.config,
      configPath: project.configPath,
      fileNames: project.fileNames,
      owners: options.owners,
      problems: options.problems,
      role: 'declaration leaf',
    });

    const typecheckConfigPath = getTypecheckConfigPath(project.configPath);

    if (!existsSync(typecheckConfigPath)) {
      continue;
    }

    addProjectOwnerProblems({
      checks: options.checks,
      config: options.config,
      configPath: typecheckConfigPath,
      fileNames: (
        await options.core.tsconfig.getProject(typecheckConfigPath, project)
      ).fileNames,
      owners: options.owners,
      problems: options.problems,
      role: 'typecheck companion',
    });
  }
}

function addRelativeImportProblems(options: {
  config: ResolvedLiminaConfig;
  filePath: string;
  importRecord: ImportRecord;
  owner: PackageOwner;
  problems: string[];
  resolvedFilePath: string | null;
}): void {
  if (!options.resolvedFilePath) {
    return;
  }

  const sourcePackageScope = findNearestPackageScopeInfo(options.filePath);
  const targetPackageScope = findNearestPackageScopeInfo(
    options.resolvedFilePath,
  );

  if (
    sourcePackageScope?.packageJsonPath === targetPackageScope?.packageJsonPath
  ) {
    return;
  }

  addRelativeImportOwnerProblem({
    config: options.config,
    importRecord: options.importRecord,
    owner: options.owner,
    problems: options.problems,
    resolvedFilePath: options.resolvedFilePath,
    sourcePackageScope,
    targetPackageScope,
  });
}

function shouldSkipBarePackageAuthorization(
  importRecord: ImportRecord,
): boolean {
  return (
    isUrlOrDataOrFileSpecifier(importRecord.specifier) ||
    isVirtualModuleSpecifier(importRecord.specifier) ||
    !isBarePackageSpecifier(importRecord.specifier) ||
    importRecord.kind === 'comment' ||
    isNodeBuiltinSpecifier(importRecord.specifier)
  );
}

function addResolvedOtherOwnerBarePackageProblems(options: {
  config: ResolvedLiminaConfig;
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  problems: string[];
  rootPackage: WorkspacePackage | null;
  target: Extract<ResolvedPackageTarget, { kind: 'other-owner' }>;
}): void {
  const packageName =
    options.target.packageInfo.name ?? options.target.targetOwner.name;

  if (!packageName) {
    addResolvedPackageWithoutNameProblem({
      config: options.config,
      importRecord: options.importRecord,
      owner: options.owner,
      packageInfo: options.target.packageInfo,
      problems: options.problems,
    });
    return;
  }

  const authorizedPackageName = getPackageNameForAuthorization({
    importRecord: options.importRecord,
    resolvedPackageName: packageName,
  });

  if (
    isDependencyAuthorizedBySourceAuthority({
      config: options.config,
      importAuthorityAllowRules: options.importAuthorityAllowRules,
      importRecord: options.importRecord,
      owner: options.owner,
      packageName: authorizedPackageName,
      rootPackage: options.rootPackage,
    })
  ) {
    return;
  }

  addPackageImportAuthorizationProblem({
    authorityManifestPaths: getDependencyAuthorityManifestPaths({
      config: options.config,
      importAuthorityAllowRules: options.importAuthorityAllowRules,
      importRecord: options.importRecord,
      owner: options.owner,
      packageName: authorizedPackageName,
      rootPackage: options.rootPackage,
    }),
    config: options.config,
    ...(authorizedPackageName === packageName
      ? {}
      : { dependencySpecifier: packageName }),
    importRecord: options.importRecord,
    owner: options.owner,
    packageName: authorizedPackageName,
    problems: options.problems,
    workspacePackage: options.target.workspacePackage,
  });
}

function addResolvedArtifactBarePackageProblems(options: {
  config: ResolvedLiminaConfig;
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  problems: string[];
  rootPackage: WorkspacePackage | null;
  target: Extract<ResolvedPackageTarget, { kind: 'artifact-package' }>;
}): void {
  if (!options.target.packageInfo.name) {
    addResolvedPackageWithoutNameProblem({
      config: options.config,
      importRecord: options.importRecord,
      owner: options.owner,
      packageInfo: options.target.packageInfo,
      problems: options.problems,
    });
    return;
  }

  const packageName = getPackageNameForAuthorization({
    importRecord: options.importRecord,
    resolvedPackageName: options.target.packageInfo.name,
  });

  if (
    isDependencyAuthorizedBySourceAuthority({
      config: options.config,
      importAuthorityAllowRules: options.importAuthorityAllowRules,
      importRecord: options.importRecord,
      owner: options.owner,
      packageName,
      rootPackage: options.rootPackage,
    })
  ) {
    return;
  }

  addPackageImportAuthorizationProblem({
    authorityManifestPaths: getDependencyAuthorityManifestPaths({
      config: options.config,
      importAuthorityAllowRules: options.importAuthorityAllowRules,
      importRecord: options.importRecord,
      owner: options.owner,
      packageName,
      rootPackage: options.rootPackage,
    }),
    config: options.config,
    ...(packageName === options.target.packageInfo.name
      ? {}
      : { dependencySpecifier: options.target.packageInfo.name }),
    importRecord: options.importRecord,
    owner: options.owner,
    packageName,
    problems: options.problems,
    workspacePackage: null,
  });
}

function addResolvedBarePackageImportProblems(options: {
  config: ResolvedLiminaConfig;
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  owners: PackageOwner[];
  packages: WorkspacePackage[];
  problems: string[];
  resolvedFilePath: string;
  rootPackage: WorkspacePackage | null;
}): boolean {
  const target = classifyResolvedPackageTarget({
    owner: options.owner,
    owners: options.owners,
    packages: options.packages,
    resolvedFilePath: options.resolvedFilePath,
  });

  if (target.kind === 'current-owner') {
    return true;
  }

  if (target.kind === 'other-owner') {
    addResolvedOtherOwnerBarePackageProblems({
      config: options.config,
      importAuthorityAllowRules: options.importAuthorityAllowRules,
      importRecord: options.importRecord,
      owner: options.owner,
      problems: options.problems,
      rootPackage: options.rootPackage,
      target,
    });
    return true;
  }

  if (target.kind === 'artifact-package') {
    addResolvedArtifactBarePackageProblems({
      config: options.config,
      importAuthorityAllowRules: options.importAuthorityAllowRules,
      importRecord: options.importRecord,
      owner: options.owner,
      problems: options.problems,
      rootPackage: options.rootPackage,
      target,
    });
    return true;
  }

  return false;
}

function addBarePackageImportProblems(options: {
  config: ResolvedLiminaConfig;
  fallbackPackageName: string;
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  owners: PackageOwner[];
  packages: WorkspacePackage[];
  problems: string[];
  resolvedFilePath: string | null;
  rootPackage: WorkspacePackage | null;
}): void {
  if (options.owner.name === options.fallbackPackageName) {
    return;
  }

  if (
    options.resolvedFilePath &&
    addResolvedBarePackageImportProblems({
      config: options.config,
      importAuthorityAllowRules: options.importAuthorityAllowRules,
      importRecord: options.importRecord,
      owner: options.owner,
      owners: options.owners,
      packages: options.packages,
      problems: options.problems,
      resolvedFilePath: options.resolvedFilePath,
      rootPackage: options.rootPackage,
    })
  ) {
    return;
  }

  const workspacePackage =
    options.packages.find(
      (candidate) => candidate.name === options.fallbackPackageName,
    ) ?? null;

  if (
    isDependencyAuthorizedBySourceAuthority({
      config: options.config,
      importAuthorityAllowRules: options.importAuthorityAllowRules,
      importRecord: options.importRecord,
      owner: options.owner,
      packageName: options.fallbackPackageName,
      rootPackage: options.rootPackage,
    })
  ) {
    return;
  }

  addPackageImportAuthorizationProblem({
    authorityManifestPaths: getDependencyAuthorityManifestPaths({
      config: options.config,
      importAuthorityAllowRules: options.importAuthorityAllowRules,
      importRecord: options.importRecord,
      owner: options.owner,
      packageName: options.fallbackPackageName,
      rootPackage: options.rootPackage,
    }),
    config: options.config,
    importRecord: options.importRecord,
    owner: options.owner,
    packageName: options.fallbackPackageName,
    problems: options.problems,
    workspacePackage,
  });
}

function addImportRecordProblems(options: {
  config: ResolvedLiminaConfig;
  filePath: string;
  importAnalysis: LiminaCore['imports']['context'];
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  owners: PackageOwner[];
  packages: WorkspacePackage[];
  problems: string[];
  project: ProjectInfo;
  rootPackage: WorkspacePackage | null;
}): void {
  const resolvedFilePath = resolveInternalImport(
    options.importRecord.specifier,
    options.filePath,
    options.project.options,
    options.project,
    options.importAnalysis,
  );

  if (isRelativeSpecifier(options.importRecord.specifier)) {
    addRelativeImportProblems({
      config: options.config,
      filePath: options.filePath,
      importRecord: options.importRecord,
      owner: options.owner,
      problems: options.problems,
      resolvedFilePath,
    });
    return;
  }

  if (isPackageImportSpecifier(options.importRecord.specifier)) {
    addPackageImportProblem({
      config: options.config,
      importRecord: options.importRecord,
      owner: options.owner,
      owners: options.owners,
      packages: options.packages,
      problems: options.problems,
      resolvedFilePath,
      importAuthorityAllowRules: options.importAuthorityAllowRules,
      rootPackage: options.rootPackage,
    });
    return;
  }

  if (shouldSkipBarePackageAuthorization(options.importRecord)) {
    return;
  }

  addBarePackageImportProblems({
    config: options.config,
    fallbackPackageName: getPackageRootSpecifier(
      options.importRecord.specifier,
    ),
    importAuthorityAllowRules: options.importAuthorityAllowRules,
    importRecord: options.importRecord,
    owner: options.owner,
    owners: options.owners,
    packages: options.packages,
    problems: options.problems,
    resolvedFilePath,
    rootPackage: options.rootPackage,
  });
}

function addSourceImportProblems(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  importAnalysis: LiminaCore['imports']['context'];
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
  owners: PackageOwner[];
  packages: WorkspacePackage[];
  problems: string[];
  rootPackage: WorkspacePackage | null;
  sourceProjectEntries: SourceProjectEntry[];
}): void {
  for (const { fileNames, project } of options.sourceProjectEntries) {
    for (const filePath of fileNames) {
      const owner = findOwnerForFile(filePath, options.owners);

      if (!owner) {
        continue;
      }

      for (const importRecord of collectImportsFromFile(
        filePath,
        options.config.rootDir,
        options.importAnalysis,
      )) {
        options.checks.add();
        addImportRecordProblems({
          config: options.config,
          filePath,
          importAnalysis: options.importAnalysis,
          importAuthorityAllowRules: options.importAuthorityAllowRules,
          importRecord,
          owner,
          owners: options.owners,
          packages: options.packages,
          problems: options.problems,
          project,
          rootPackage: options.rootPackage,
        });
      }
    }
  }
}

function getProblemTitle(problem: string): string {
  return (problem.split('\n')[0]?.trim() || 'Source check issue').replace(
    /:+$/u,
    '',
  );
}

function getProblemLineValue(
  problem: string,
  label: string,
): string | undefined {
  const escapedLabel = label.replaceAll(
    /[.*+?^${}()|[\]\\]/gu,
    String.raw`\$&`,
  );
  const match = new RegExp(String.raw`^\s*${escapedLabel}:\s*(.+)$`, 'mu').exec(
    problem,
  );

  return match?.[1]?.trim();
}

function stripProblemLocationSuffix(filePath: string): string {
  return filePath.replace(/:\d+(?::\d+)?(?:\s+\(.+\))?$/u, '');
}

function getSourceProblemCode(title: string): string {
  if (title.includes('Knip') || title.includes('knip')) {
    if (title.includes('build script')) {
      return LIMINA_CHECK_ISSUE_CODES.sourceKnipBuildScriptUnsupported;
    }

    return LIMINA_CHECK_ISSUE_CODES.sourceKnipConfigInvalid;
  }

  if (title.includes('import authority')) {
    return LIMINA_CHECK_ISSUE_CODES.sourceImportAuthorityInvalid;
  }

  if (title.startsWith('Unauthorized bare package import')) {
    return LIMINA_CHECK_ISSUE_CODES.sourcePackageImportUnauthorized;
  }

  if (title.startsWith('Relative import escapes package scope')) {
    return LIMINA_CHECK_ISSUE_CODES.sourceRelativeImportEscapesScope;
  }

  if (title.includes('package import') || title.includes('Package import')) {
    return LIMINA_CHECK_ISSUE_CODES.sourcePackageImportInvalid;
  }

  if (title.includes('Tsconfig') || title.includes('tsconfig')) {
    return LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance;
  }

  if (title.includes('source owner') || title.includes('source owners')) {
    return LIMINA_CHECK_ISSUE_CODES.sourceOwnerInvalid;
  }

  return LIMINA_CHECK_ISSUE_CODES.sourceCheckFailed;
}

function getSourceProblemFilePath(problem: string): string | undefined {
  const rawFile =
    getProblemLineValue(problem, 'file') ??
    getProblemLineValue(problem, 'config') ??
    getProblemLineValue(problem, 'project') ??
    getProblemLineValue(problem, 'declaration leaf') ??
    getProblemLineValue(problem, 'typecheck companion') ??
    getProblemLineValue(problem, 'resolver tsconfig');

  return rawFile ? stripProblemLocationSuffix(rawFile) : undefined;
}

function getSourceProblemManifestPath(problem: string): string | undefined {
  return (
    getProblemLineValue(problem, 'source owner') ??
    getProblemLineValue(problem, 'package owner') ??
    getProblemLineValue(problem, 'package manifest') ??
    getProblemLineValue(problem, 'package scope')
  );
}

function createSourceProblemOwnerLookup(
  owners: readonly PackageOwner[],
): Map<string, string> {
  return new Map(
    owners.flatMap((owner) =>
      owner.name
        ? [[normalizeSlashes(owner.packageJsonPath), owner.name] as const]
        : [],
    ),
  );
}

function getStructuredSourceIssueOwnerName(options: {
  ownerNamesByManifestPath: Map<string, string>;
  problem: string;
}): string {
  const fieldPackageName = /source\.knip\.workspaces\["([^"]+)"\]/u.exec(
    getProblemLineValue(options.problem, 'field') ?? '',
  )?.[1];

  if (fieldPackageName) {
    return fieldPackageName;
  }

  const manifestPath = getSourceProblemManifestPath(options.problem);

  if (manifestPath) {
    const normalizedManifestPath = normalizeSlashes(manifestPath);
    const ownerName =
      options.ownerNamesByManifestPath.get(normalizedManifestPath) ??
      [...options.ownerNamesByManifestPath.entries()].find(([key]) =>
        key.endsWith(normalizedManifestPath),
      )?.[1];

    if (ownerName) {
      return ownerName;
    }
  }

  return (
    getProblemLineValue(options.problem, 'package') ??
    getProblemLineValue(options.problem, 'workspace package') ??
    '<workspace>'
  );
}

function createStructuredSourceIssueFromProblem(options: {
  ownerNamesByManifestPath: Map<string, string>;
  problem: string;
}): SourceStructuredIssue {
  const title = getProblemTitle(options.problem);
  const filePath = getSourceProblemFilePath(options.problem);
  const packageJsonPath = getSourceProblemManifestPath(options.problem);
  const field = getProblemLineValue(options.problem, 'field');
  const fix = getProblemLineValue(options.problem, 'fix');

  return {
    code: getSourceProblemCode(title),
    detector: 'source',
    evidence: [
      {
        label: 'diagnostic',
        lines: options.problem.split('\n'),
      },
    ],
    filePath,
    fix,
    fixSteps: fix ? [fix] : undefined,
    locations: field ? [{ label: 'field', scope: field }] : undefined,
    ownerName: getStructuredSourceIssueOwnerName({
      ownerNamesByManifestPath: options.ownerNamesByManifestPath,
      problem: options.problem,
    }),
    packageJsonPath,
    reason:
      getProblemLineValue(options.problem, 'reason') ??
      'Source check found package ownership, import authority, tsconfig governance, or Knip configuration violations.',
    summary: title,
    title,
    tool: title.includes('Knip') || title.includes('knip') ? 'knip' : 'limina',
    verifyCommands: ['limina source check'],
  };
}

export async function runSourceCheckImpl(
  config: ResolvedLiminaConfig,
  options: {
    core?: LiminaCore;
    generatedGraphProvider?: () => Promise<GeneratedTsconfigGraphResult>;
    knipRunner?: KnipCliRunner;
    deferSnapshot?: boolean;
    legacyProblems?: string[];
    logSuccess?: boolean;
    onStats?: (stats: LiminaCheckRunTaskStats) => void;
    preflight?: LiminaPreflightManager;
    progress?: TaskProgressReporter;
    report?: SourceIssueReportOptions;
    sourceIssues?: SourceCheckIssue[];
  } = {},
): Promise<boolean> {
  const problems: string[] = [];
  const sourceIssues: SourceCheckIssue[] = [];
  const checks = createCheckCounter();
  const checkItems = createCheckItemAccumulator(
    () => problems.length + sourceIssues.length,
    () => checks.value,
    {
      plannedItems: SOURCE_CHECK_ITEM_NAMES,
      progress: options.progress,
    },
  );
  const preflight = resolvePreflight(config, options);
  const core = preflight.core;
  const generatedGraph = await preflight.ensureGeneratedGraph();
  const graphRoute = await preflight.ensureSourceGraphProjectExtensions();
  const projectPaths = [...graphRoute.projectExtensionsByPath.keys()].sort();
  const projects = await Promise.all(
    projectPaths.map((projectPath) =>
      core.tsconfig.getProject(
        projectPath,
        graphRoute.projectContextsByPath.get(projectPath),
      ),
    ),
  );
  const sourceProjectEntries = await createSourceProjectEntries(core, projects);
  const packages = await preflight.ensureWorkspacePackages();
  const packageOwners = await preflight.ensurePackageOwners();
  const workspaceDependencyDeclarations =
    await preflight.ensureWorkspaceDependencyDeclarations();
  const rootPackage = findWorkspaceRootPackage({
    config,
    packages,
  });
  const ownerModuleSets = collectOwnerSourceModuleSets({
    owners: packageOwners,
    sourceProjectEntries,
  });
  const importAnalysis = preflight.importAnalysis;

  checkItems.start('source graph routes');
  problems.push(...graphRoute.problems);
  checks.add(projectPaths.length);
  checkItems.record('source graph routes');

  checkItems.start('tsconfig governance');
  await addTsconfigGovernanceProblems({
    checks,
    config,
    configPaths: collectGeneratedSourceConfigPaths(generatedGraph),
    generatedGraph,
    owners: packageOwners,
    problems,
  });
  checkItems.record('tsconfig governance');

  checkItems.start('knip source usage');
  await addKnipBackedSourceProblems({
    checks,
    config,
    generatedGraph,
    knipRunner: options.knipRunner,
    ownerModuleSets,
    problems,
    sourceIssues,
    workspaceDependencyDeclarations,
    workspacePackages: packages,
  });
  checkItems.record('knip source usage');

  checkItems.start('source project ownership');
  await addSourceProjectOwnerProblems({
    checks,
    config,
    core,
    owners: packageOwners,
    problems,
    projects,
  });
  checkItems.record('source project ownership');

  checkItems.start('source import authority');
  const importAuthorityAllowRules = collectImportAuthorityAllowRules({
    checks,
    config,
    problems,
  });
  addImportAuthorityRootManifestConfigProblems({
    checks,
    config,
    importAuthorityAllowRules,
    problems,
  });

  addSourceImportProblems({
    checks,
    config,
    importAnalysis,
    importAuthorityAllowRules,
    owners: packageOwners,
    packages,
    problems,
    rootPackage,
    sourceProjectEntries,
  });
  checkItems.record('source import authority');

  const ownerNamesByManifestPath =
    createSourceProblemOwnerLookup(packageOwners);
  const structuredSourceIssues = [
    ...sourceIssues,
    ...problems.map((problem) =>
      createStructuredSourceIssueFromProblem({
        ownerNamesByManifestPath,
        problem,
      }),
    ),
  ];

  options.sourceIssues?.push(...structuredSourceIssues);

  if (!options.deferSnapshot) {
    await writeCompletedSourceIssueSnapshot({
      command: options.report?.command ?? 'limina source check',
      issues: structuredSourceIssues,
      legacyProblems: [],
      rootDir: config.rootDir,
    });
  }

  if (structuredSourceIssues.length > 0) {
    options.onStats?.({
      items: checkItems.getItems(),
      passed: 0,
      total: checks.value,
    });

    if (options.report?.defer) {
      return false;
    }

    SourceLogger.error(
      formatSourceCheckHumanReport({
        config,
        issues: structuredSourceIssues,
        legacyProblems: [],
        report: options.report,
      }),
    );
    return false;
  }

  if (options.logSuccess ?? true) {
    SourceLogger.success(
      `Checked ${sourceProjectEntries.length} source project owners; package scopes are valid.`,
    );
  }

  options.onStats?.({
    items: checkItems.getItems(),
    passed: checks.value,
    total: checks.value,
  });

  return true;
}
