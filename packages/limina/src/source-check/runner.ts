import {
  type CheckerProjectParseContext,
  normalizeExtensions,
} from '#checkers';
import { getActiveCheckers, type ResolvedLiminaConfig } from '#config/runner';
import type { AnalysisProviderSet } from '#core';
import {
  collectGeneratedSourceConfigPaths,
  type GeneratedTsconfigGraphResult,
} from '#core/build-graph/runner';
import {
  collectImportsFromFile,
  formatImportRecordLocation,
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
  type PackageImportMatch,
  type WorkspaceDependencyDeclaration,
} from '../core/packages/authority';
import type {
  NearestPackageInfo,
  ResolvedPackageTarget,
} from '../core/packages/owners';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import {
  getWorkspaceRegionBoundaryExclusionReason,
  type WorkspaceRegionBoundary,
} from '../core/workspace/regions';
import { WorkspaceRegionPathIndex } from '../core/workspace/validated-context';
import type { TaskProgressReporter } from '../execution/progress';
import {
  formatMissingOptionalToolSkipMessage,
  isLiminaOptionalToolMissingError,
} from '../execution/tools';
import type { LiminaFlowReporter } from '../flow';
import { isNodeBuiltinSpecifier } from '../graph-check/rules';
import { SourceLogger } from '../logger';
import { type LiminaPreflightManager, resolvePreflight } from '../preflight';
import {
  type AmbientDeclarationIndex,
  createAmbientDeclarationIndex,
} from './ambient-declarations';
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
  collectGeneratedArtifactSourceEntryPatterns,
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
  writeCompletedStandaloneSourceCheckSnapshots,
} from './snapshot';
import {
  isInvalidConfigRootPattern,
  normalizeWorkspacePattern,
} from './workspace-patterns';

export interface RunSourceCheckOptions {
  clearScreen?: boolean;
  providers?: AnalysisProviderSet;
  deferSnapshot?: boolean;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  generatedGraphProvider?: () => Promise<GeneratedTsconfigGraphResult>;
  issues?: LiminaCheckIssue[];
  knipRunner?: KnipCliRunner;
  onStats?: (stats: LiminaCheckRunTaskStats) => void;
  onSourceSnapshot?: (issues: readonly SourceCheckIssue[]) => void;
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

function filterProjectInfoToActivatedRegion(
  project: ProjectInfo,
  workspaceLookup: WorkspaceLookupIndex,
): ProjectInfo {
  return {
    ...project,
    fileNames: project.fileNames.filter((fileName) =>
      workspaceLookup.isInsideActivatedRegion(fileName),
    ),
    ownedFileNames: project.ownedFileNames.filter((fileName) =>
      workspaceLookup.isInsideActivatedRegion(fileName),
    ),
  };
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
  appliesToAllGovernedOwnerSources: boolean;
  grantIndex: number;
  includeMatchers: ((value: string) => boolean)[];
  ownerIdentity: string;
  packageMatchers: ((value: string) => boolean)[];
  reason: string;
}

interface PackageImportAuthorizationResolution {
  authorityManifestPaths: string[];
  authorized: boolean;
  intermediateDependencyPackage?: WorkspacePackage;
  matchedGrant?: CompiledImportAuthorityAllowRule;
}

function addProjectOwnerProblems(options: {
  ambientDeclarations: AmbientDeclarationIndex;
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  configPath: string;
  fileNames: string[];
  problems: string[];
  role: 'declaration leaf' | 'typecheck companion';
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const ownerPaths = new Map<string, PackageOwner>();
  const missingOwnerFiles: string[] = [];

  for (const fileName of options.fileNames) {
    options.checks.add();

    if (options.ambientDeclarations.has(fileName)) {
      continue;
    }

    const owner = options.workspaceLookup.findOwnerForFile(fileName);

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

function addSourceCrossGovernanceBoundaryProblem(options: {
  boundary: WorkspaceRegionBoundary;
  config: ResolvedLiminaConfig;
  importRecord: ImportRecord;
  owner: PackageOwner;
  problems: string[];
  resolvedFilePath: string;
}): void {
  const exclusionReason = getWorkspaceRegionBoundaryExclusionReason(
    options.boundary,
  );

  options.problems.push(
    [
      'Source import crosses governance boundary:',
      `  source owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
      `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
      `  imported specifier: ${options.importRecord.specifier}`,
      `  resolved file: ${toRelativePath(options.config.rootDir, options.resolvedFilePath)}`,
      `  current region: ${toRelativePath(options.config.rootDir, path.join(options.config.rootDir, 'pnpm-workspace.yaml'))}`,
      `  boundary kind: ${options.boundary.kind}`,
      `  boundary root: ${toRelativePath(options.config.rootDir, options.boundary.rootDir)}`,
      ...(options.boundary.kind === 'pnpm-workspace'
        ? [
            `  boundary config: ${toRelativePath(options.config.rootDir, options.boundary.workspaceYamlPath)}`,
          ]
        : [
            `  boundary manifest: ${toRelativePath(options.config.rootDir, options.boundary.packageJsonPath)}`,
          ]),
      ...(exclusionReason
        ? [`  excluded boundary reason: ${exclusionReason}`]
        : []),
      '  reason: current-region source must not import source files beyond a stopped or excluded governance boundary during a single Limina run.',
      '  fix: remove the cross-boundary source import, activate an eligible package scope, or consume a published package artifact instead of local source.',
    ].join('\n'),
  );
}

function addSourceImportOutsideActivatedRegionProblem(options: {
  config: ResolvedLiminaConfig;
  importRecord: ImportRecord;
  owner: PackageOwner;
  problems: string[];
  resolvedFilePath: string;
}): void {
  options.problems.push(
    [
      'Source import resolves outside activated workspace package regions:',
      `  source owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
      `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
      `  imported specifier: ${options.importRecord.specifier}`,
      `  resolved file: ${toRelativePath(options.config.rootDir, options.resolvedFilePath)}`,
      '  reason: current-run source governance is bounded by activated workspace packages; local repo files outside those packages cannot be imported as governed source.',
      '  fix: move the target into an activated workspace package, activate the owning package for this run, or consume it as a package artifact instead of a local source file.',
    ].join('\n'),
  );
}

function addPackageImportAuthorizationProblem(options: {
  authorization: PackageImportAuthorizationResolution;
  config: ResolvedLiminaConfig;
  dependencySpecifier?: string;
  importRecord: ImportRecord;
  owner: PackageOwner;
  packageName: string;
  problems: string[];
  workspacePackage: WorkspacePackage | null;
}): void {
  const ownerIdentity = getSourceOwnerIdentity({
    config: options.config,
    owner: options.owner,
  });
  const fix = formatPackageImportAuthorizationFix({
    ...options,
    authorization: options.authorization,
    ownerIdentity,
  });
  const matchedGrantPath = options.authorization.matchedGrant
    ? formatImportAuthorityGrantPath(options.authorization.matchedGrant)
    : undefined;
  const rootPackageJsonPath = normalizeAbsolutePath(
    path.join(options.config.rootDir, 'package.json'),
  );
  const rootManifestDoesNotDeclarePackage =
    options.authorization.matchedGrant &&
    existsSync(rootPackageJsonPath) &&
    options.authorization.authorityManifestPaths.includes(
      rootPackageJsonPath,
    ) &&
    !options.authorization.intermediateDependencyPackage;

  options.problems.push(
    [
      'Unauthorized bare package import:',
      `  source owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
      `  owner identity: ${ownerIdentity}`,
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
      ...options.authorization.authorityManifestPaths.map(
        (manifestPath) =>
          `    - ${toRelativePath(options.config.rootDir, manifestPath)}`,
      ),
      ...(matchedGrantPath
        ? ['  matched import authority grant:', `    ${matchedGrantPath}`]
        : []),
      ...(options.authorization.intermediateDependencyPackage
        ? [
            `  reason: source import authority can only use the owner package.json or an explicitly configured workspace root dependency grant. An intermediate workspace package declares "${options.packageName}", so the workspace root grant must not bypass it.`,
            '  intermediate dependency declaration:',
            `    package.json: ${toRelativePath(
              options.config.rootDir,
              getWorkspacePackageJsonPath(
                options.authorization.intermediateDependencyPackage,
              ),
            )}`,
          ]
        : rootManifestDoesNotDeclarePackage
          ? [
              `  reason: the grant allows workspace root dependency authority, but the workspace root package.json does not declare "${options.packageName}".`,
            ]
          : [
              '  reason: source imports must be declared by the nearest pnpm workspace source owner or by an explicitly configured workspace root dependency grant.',
            ]),
      `  fix: ${fix}`,
    ].join('\n'),
  );
}

function formatPackageImportAuthorizationFix(options: {
  authorization: PackageImportAuthorizationResolution;
  config: ResolvedLiminaConfig;
  dependencySpecifier?: string;
  importRecord: ImportRecord;
  owner: PackageOwner;
  ownerIdentity: string;
  packageName: string;
  workspacePackage: WorkspacePackage | null;
}): string {
  const ownerManifestPath = toRelativePath(
    options.config.rootDir,
    options.owner.packageJsonPath,
  );
  const rootAuthorityFix = ` If this package is intentionally declared by the workspace root, add source.importAuthority.allow["${options.ownerIdentity}"] with workspaceRootDependencies: ["${options.packageName}"] and a reason.`;
  const intermediateAuthorityFix = options.authorization
    .intermediateDependencyPackage
    ? ` Remove or relocate the intermediate declaration if it is not the intended authority, or avoid relying on workspace root dependency authority for this import.`
    : '';
  const typeDeclarationFix =
    options.dependencySpecifier?.startsWith('@types/') &&
    options.dependencySpecifier !== options.packageName
      ? ` "${options.dependencySpecifier}" only supplies declarations and does not authorize "${options.packageName}".`
      : '';
  return [
    `Declare "${options.packageName}" in ${ownerManifestPath} dependencies, devDependencies, peerDependencies, or optionalDependencies.`,
    rootAuthorityFix,
    intermediateAuthorityFix,
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

function formatImportAuthorityGrantPath(
  rule: CompiledImportAuthorityAllowRule,
): string {
  return `source.importAuthority.allow[${JSON.stringify(rule.ownerIdentity)}][${rule.grantIndex}]`;
}

function collectIntermediateWorkspacePackages(options: {
  config: ResolvedLiminaConfig;
  owner: PackageOwner;
  packages: WorkspacePackage[];
}): WorkspacePackage[] {
  const ownerDirectory = normalizeAbsolutePath(options.owner.directory);
  const rootDirectory = normalizeAbsolutePath(options.config.rootDir);

  return options.packages
    .filter((workspacePackage) => {
      const packageDirectory = normalizeAbsolutePath(
        workspacePackage.directory,
      );

      return (
        packageDirectory !== ownerDirectory &&
        packageDirectory !== rootDirectory &&
        isPathInsideDirectory(ownerDirectory, packageDirectory)
      );
    })
    .sort(
      (left, right) =>
        normalizeAbsolutePath(right.directory).length -
        normalizeAbsolutePath(left.directory).length,
    );
}

function getImportAuthorityOwnerKeyReason(ownerKey: string): string {
  if (ownerKey.trim().length === 0) {
    return 'source.importAuthority.allow keys must be non-empty source owner identities.';
  }

  if (ownerKey === '*' || ownerKey === '<root>' || ownerKey === '<workspace>') {
    return 'global source import authority owner keys are not supported.';
  }

  if (/[*?[\]{}()!+]/u.test(ownerKey)) {
    return 'owner glob keys are not supported; keys must match known workspace source owners.';
  }

  return 'source.importAuthority.allow keys must match known workspace source owners.';
}

function getClosestOwnerSuggestion(
  ownerKey: string,
  ownerIdentities: string[],
): string | undefined {
  let bestSuggestion: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const ownerIdentity of ownerIdentities) {
    const distance = getEditDistance(ownerKey, ownerIdentity);

    if (distance < bestDistance) {
      bestDistance = distance;
      bestSuggestion = ownerIdentity;
    }
  }

  const threshold = Math.max(3, Math.floor(ownerKey.length / 3));

  return bestDistance <= threshold ? bestSuggestion : undefined;
}

function getEditDistance(left: string, right: string): number {
  const leftCharacters = Array.from(left);
  const rightCharacters = Array.from(right);
  const previous = Array.from(
    { length: rightCharacters.length + 1 },
    (_, index) => index,
  );

  for (const [leftIndex, element] of leftCharacters.entries()) {
    const current = [leftIndex + 1];

    for (const [rightIndex, element_] of rightCharacters.entries()) {
      const substitutionCost = element === element_ ? 0 : 1;
      current[rightIndex + 1] = Math.min(
        current[rightIndex]! + 1,
        previous[rightIndex + 1]! + 1,
        previous[rightIndex]! + substitutionCost,
      );
    }

    previous.splice(0, previous.length, ...current);
  }

  return previous[rightCharacters.length] ?? Number.POSITIVE_INFINITY;
}

function addImportAuthorityOwnerConfigProblems(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  ownerIdentities: Set<string>;
  problems: string[];
}): void {
  const rawAllow = options.config.source?.importAuthority?.allow;

  if (!rawAllow || Array.isArray(rawAllow) || !isPlainConfigRecord(rawAllow)) {
    return;
  }

  const sortedOwnerIdentities = [...options.ownerIdentities].sort();

  for (const ownerKey of Object.keys(rawAllow)) {
    options.checks.add();

    if (options.ownerIdentities.has(ownerKey)) {
      continue;
    }

    const suggestion = getClosestOwnerSuggestion(
      ownerKey,
      sortedOwnerIdentities,
    );

    options.problems.push(
      [
        'Invalid source import authority config:',
        `  field: source.importAuthority.allow[${JSON.stringify(ownerKey)}]`,
        `  owner: ${ownerKey}`,
        `  reason: ${getImportAuthorityOwnerKeyReason(ownerKey)}`,
        '  fix: use an existing workspace package name, or the config-root-relative owner directory for nameless owners.',
        ...(suggestion ? ['  did you mean:', `    - ${suggestion}`] : []),
      ].join('\n'),
    );
  }
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

function resolvePackageImportAuthorization(options: {
  config: ResolvedLiminaConfig;
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  packageName: string;
  packages: WorkspacePackage[];
  rootPackage: WorkspacePackage | null;
}): PackageImportAuthorizationResolution {
  const manifestPaths = [options.owner.packageJsonPath];

  if (isDependencyAuthorized(options.owner.manifest, options.packageName)) {
    return {
      authorityManifestPaths: manifestPaths,
      authorized: true,
    };
  }

  const matchedGrant = findMatchingWorkspaceRootDependencyGrant({
    config: options.config,
    importAuthorityAllowRules: options.importAuthorityAllowRules,
    importRecord: options.importRecord,
    owner: options.owner,
    packageName: options.packageName,
  });

  if (
    !matchedGrant ||
    !options.rootPackage ||
    normalizeAbsolutePath(options.rootPackage.directory) ===
      normalizeAbsolutePath(options.owner.directory)
  ) {
    return {
      authorityManifestPaths: manifestPaths,
      authorized: false,
      ...(matchedGrant ? { matchedGrant } : {}),
    };
  }

  const intermediatePackages = collectIntermediateWorkspacePackages({
    config: options.config,
    owner: options.owner,
    packages: options.packages,
  });
  const rootPackageJsonPath = getWorkspacePackageJsonPath(options.rootPackage);
  manifestPaths.push(
    ...intermediatePackages.map((workspacePackage) =>
      getWorkspacePackageJsonPath(workspacePackage),
    ),
    rootPackageJsonPath,
  );
  const intermediateDependencyPackage = intermediatePackages.find(
    (workspacePackage) =>
      isDependencyAuthorized(workspacePackage.manifest, options.packageName),
  );

  if (intermediateDependencyPackage) {
    return {
      authorityManifestPaths: manifestPaths,
      authorized: false,
      intermediateDependencyPackage,
      matchedGrant,
    };
  }

  if (
    isDependencyAuthorized(options.rootPackage.manifest, options.packageName)
  ) {
    return {
      authorityManifestPaths: manifestPaths,
      authorized: true,
      matchedGrant,
    };
  }

  return {
    authorityManifestPaths: manifestPaths,
    authorized: false,
    matchedGrant,
  };
}

interface PackageImportAuthorityTarget {
  requestedPackageName: string;
  resolvedPackageName?: string;
}

function getBarePackageImportAuthorityTarget(options: {
  importRecord: ImportRecord;
  resolvedPackageName?: string;
}): PackageImportAuthorityTarget {
  const requestedPackageName = getPackageRootSpecifier(
    options.importRecord.specifier,
  );

  return {
    requestedPackageName,
    ...(options.resolvedPackageName
      ? { resolvedPackageName: options.resolvedPackageName }
      : {}),
  };
}

function getResolvedPackageNameDiagnostic(
  authorityTarget: PackageImportAuthorityTarget,
): string | undefined {
  return authorityTarget.resolvedPackageName &&
    authorityTarget.resolvedPackageName !== authorityTarget.requestedPackageName
    ? authorityTarget.resolvedPackageName
    : undefined;
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

function isPlainConfigRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
  const rawAllow = options.config.source?.importAuthority?.allow;

  if (rawAllow === undefined) {
    return [];
  }

  if (Array.isArray(rawAllow) || !isPlainConfigRecord(rawAllow)) {
    options.checks.add();
    options.problems.push(
      [
        'Invalid source import authority config:',
        '  field: source.importAuthority.allow',
        '  reason: allow must be an object keyed by source owner identity.',
        '  fix: use allow: { "@scope/package": [{ include: ["test/**/*.ts"], workspaceRootDependencies: ["@example/fixture"], reason: "..." }] }.',
      ].join('\n'),
    );
    return [];
  }

  const rules: CompiledImportAuthorityAllowRule[] = [];

  for (const [ownerIdentity, grants] of Object.entries(rawAllow)) {
    options.checks.add();

    if (!Array.isArray(grants)) {
      options.problems.push(
        [
          'Invalid source import authority config:',
          `  field: source.importAuthority.allow[${JSON.stringify(ownerIdentity)}]`,
          '  reason: allow owner entries must be arrays of grants.',
        ].join('\n'),
      );
      continue;
    }

    for (const [grantIndex, grant] of grants.entries()) {
      options.checks.add();

      if (!isPlainConfigRecord(grant)) {
        options.problems.push(
          [
            'Invalid source import authority config:',
            `  field: source.importAuthority.allow[${JSON.stringify(ownerIdentity)}][${grantIndex}]`,
            '  reason: importAuthority allow grants must be objects with workspaceRootDependencies and reason fields.',
          ].join('\n'),
        );
        continue;
      }

      const include = Array.isArray(grant.include)
        ? grant.include
            .map((file) =>
              typeof file === 'string' ? normalizeWorkspacePattern(file) : '',
            )
            .filter((file) => file.length > 0)
        : [];
      const invalidInclude = include.find(isInvalidConfigRootPattern);

      if (grant.include !== undefined && include.length === 0) {
        options.problems.push(
          [
            'Invalid source import authority config:',
            `  field: source.importAuthority.allow[${JSON.stringify(ownerIdentity)}][${grantIndex}].include`,
            '  reason: include must be a non-empty string array when configured.',
          ].join('\n'),
        );
        continue;
      }

      if (invalidInclude) {
        options.problems.push(
          [
            'Invalid source import authority config:',
            `  field: source.importAuthority.allow[${JSON.stringify(ownerIdentity)}][${grantIndex}].include`,
            `  file: ${invalidInclude}`,
            '  reason: include must use positive config-root-relative globs.',
          ].join('\n'),
        );
        continue;
      }

      if (
        !Array.isArray(grant.workspaceRootDependencies) ||
        grant.workspaceRootDependencies.length === 0 ||
        grant.workspaceRootDependencies.some(
          (value) => typeof value !== 'string' || value.trim().length === 0,
        )
      ) {
        options.problems.push(
          [
            'Invalid source import authority config:',
            `  field: source.importAuthority.allow[${JSON.stringify(ownerIdentity)}][${grantIndex}].workspaceRootDependencies`,
            '  reason: workspaceRootDependencies must be a non-empty string array.',
          ].join('\n'),
        );
        continue;
      }

      if (
        typeof grant.reason !== 'string' ||
        grant.reason.trim().length === 0
      ) {
        options.problems.push(
          [
            'Invalid source import authority config:',
            `  field: source.importAuthority.allow[${JSON.stringify(ownerIdentity)}][${grantIndex}].reason`,
            '  reason: reason must be a non-empty string.',
          ].join('\n'),
        );
        continue;
      }

      rules.push({
        appliesToAllGovernedOwnerSources: grant.include === undefined,
        grantIndex,
        includeMatchers: include.map((file) =>
          picomatch(file, {
            dot: true,
            posixSlashes: true,
          }),
        ),
        ownerIdentity,
        packageMatchers: grant.workspaceRootDependencies.map((value) =>
          createValueMatcher(value.trim()),
        ),
        reason: grant.reason.trim(),
      });
    }
  }

  return rules;
}

function hasImportAuthorityWorkspaceRootDependencyGrants(
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

  if (
    !hasImportAuthorityWorkspaceRootDependencyGrants(
      options.importAuthorityAllowRules,
    )
  ) {
    return;
  }

  const rootPackageJsonPath = path.join(options.config.rootDir, 'package.json');

  if (existsSync(rootPackageJsonPath)) {
    return;
  }

  options.problems.push(
    [
      'Invalid source import authority config:',
      '  field: source.importAuthority.allow',
      '  reason: workspaceRootDependencies grants require a workspace root package.json.',
      '  fix: create a workspace root package.json, or remove workspaceRootDependencies grants.',
    ].join('\n'),
  );
}

function getImportAuthorityRuleContext(options: {
  config: ResolvedLiminaConfig;
  importRecord: ImportRecord;
  owner: PackageOwner;
}): {
  configRootRelativeFilePath: string;
  ownerIdentity: string;
} {
  return {
    configRootRelativeFilePath: normalizeSlashes(
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
    configRootRelativeFilePath: string;
    ownerIdentity: string;
  },
): boolean {
  if (rule.ownerIdentity !== context.ownerIdentity) {
    return false;
  }

  if (rule.appliesToAllGovernedOwnerSources) {
    return true;
  }

  return rule.includeMatchers.some((matches) =>
    matches(context.configRootRelativeFilePath),
  );
}

function findMatchingWorkspaceRootDependencyGrant(options: {
  config: ResolvedLiminaConfig;
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  packageName: string;
}): CompiledImportAuthorityAllowRule | undefined {
  if (options.importAuthorityAllowRules.length === 0) {
    return undefined;
  }

  const context = getImportAuthorityRuleContext({
    config: options.config,
    importRecord: options.importRecord,
    owner: options.owner,
  });

  return options.importAuthorityAllowRules.find((rule) => {
    return (
      isImportAuthorityRuleInScope(rule, context) &&
      rule.packageMatchers.some((matches) => matches(options.packageName))
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

function addPackageImportRelativeScopeProblem(options: {
  config: ResolvedLiminaConfig;
  importRecord: ImportRecord;
  owner: PackageOwner;
  packageScope: NearestPackageInfo;
  problems: string[];
  resolvedFilePath: string;
  targetPackageScope: NearestPackageInfo | null;
}): void {
  options.problems.push(
    [
      'Package import relative target escapes package scope:',
      `  source owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
      `  package scope: ${toRelativePath(options.config.rootDir, options.packageScope.packageJsonPath)}`,
      `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
      `  imported specifier: ${options.importRecord.specifier}`,
      `  resolved file: ${toRelativePath(options.config.rootDir, options.resolvedFilePath)}`,
      ...(options.targetPackageScope
        ? [
            `  target package scope: ${toRelativePath(options.config.rootDir, options.targetPackageScope.packageJsonPath)}`,
          ]
        : []),
      '  reason: #... package imports with relative targets must stay inside the declaring package scope.',
    ].join('\n'),
  );
}

function isResolvedInsidePackageScope(options: {
  packageScope: NearestPackageInfo;
  resolvedFilePath: string;
  workspaceLookup: WorkspaceLookupIndex;
}): boolean {
  return (
    options.workspaceLookup.findNearestPackageScopeInfo(
      options.resolvedFilePath,
    )?.packageJsonPath === options.packageScope.packageJsonPath
  );
}

function addPackageImportArtifactAuthorizationProblem(options: {
  config: ResolvedLiminaConfig;
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  packages: WorkspacePackage[];
  packageInfo: NearestPackageInfo;
  problems: string[];
  rootPackage: WorkspacePackage | null;
  workspacePackage: WorkspacePackage | null;
}): void {
  if (!options.packageInfo.name) {
    addResolvedPackageWithoutNameProblem({
      config: options.config,
      importRecord: options.importRecord,
      owner: options.owner,
      packageInfo: options.packageInfo,
      problems: options.problems,
    });
    return;
  }

  const packageName = options.packageInfo.name;
  const authorization = resolvePackageImportAuthorization({
    config: options.config,
    importAuthorityAllowRules: options.importAuthorityAllowRules,
    importRecord: options.importRecord,
    owner: options.owner,
    packageName,
    packages: options.packages,
    rootPackage: options.rootPackage,
  });

  if (authorization.authorized) {
    return;
  }

  addPackageImportAuthorizationProblem({
    authorization,
    config: options.config,
    importRecord: options.importRecord,
    owner: options.owner,
    packageName,
    problems: options.problems,
    workspacePackage: options.workspacePackage,
  });
}

function shouldTreatPackageImportAsRelativeTarget(
  match: PackageImportMatch,
): boolean {
  return match.targetKind === 'relative';
}

function shouldTreatPackageImportAsPackageTarget(
  match: PackageImportMatch,
): boolean {
  return match.targetKind === 'package' || match.targetKind === 'mixed';
}

function addPackageImportProblem(options: {
  config: ResolvedLiminaConfig;
  importRecord: ImportRecord;
  owner: PackageOwner;
  packages: WorkspacePackage[];
  problems: string[];
  resolvedFilePath: string | null;
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
  rootPackage: WorkspacePackage | null;
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const packageScope = options.workspaceLookup.findNearestPackageScopeInfo(
    options.importRecord.filePath,
  );
  const match = findPackageImportMatch(
    packageScope?.manifest.imports,
    options.importRecord.specifier,
  );

  if (!match) {
    options.problems.push(
      [
        'Unauthorized package import specifier:',
        `  source owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
        ...(packageScope
          ? [
              `  package scope: ${toRelativePath(options.config.rootDir, packageScope.packageJsonPath)}`,
            ]
          : []),
        `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
        `  imported specifier: ${options.importRecord.specifier}`,
        '  reason: #... package imports must match the nearest package scope package.json imports field.',
      ].join('\n'),
    );
    return;
  }

  if (!options.resolvedFilePath) {
    options.problems.push(
      [
        'Unresolved package import specifier:',
        `  source owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
        ...(packageScope
          ? [
              `  package scope: ${toRelativePath(options.config.rootDir, packageScope.packageJsonPath)}`,
            ]
          : []),
        `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
        `  imported specifier: ${options.importRecord.specifier}`,
        '  reason: matched #... package imports must resolve from the nearest package scope package.json imports field.',
      ].join('\n'),
    );
    return;
  }

  if (
    packageScope &&
    shouldTreatPackageImportAsRelativeTarget(match) &&
    !isResolvedInsidePackageScope({
      packageScope,
      resolvedFilePath: options.resolvedFilePath,
      workspaceLookup: options.workspaceLookup,
    })
  ) {
    addPackageImportRelativeScopeProblem({
      config: options.config,
      importRecord: options.importRecord,
      owner: options.owner,
      packageScope,
      problems: options.problems,
      resolvedFilePath: options.resolvedFilePath,
      targetPackageScope: options.workspaceLookup.findNearestPackageScopeInfo(
        options.resolvedFilePath,
      ),
    });
    return;
  }

  const target = options.workspaceLookup.classifyResolvedPackageTarget({
    owner: options.owner,
    resolvedFilePath: options.resolvedFilePath,
  });

  if (target.kind === 'current-owner') {
    if (
      packageScope &&
      !shouldTreatPackageImportAsPackageTarget(match) &&
      !isResolvedInsidePackageScope({
        packageScope,
        resolvedFilePath: options.resolvedFilePath,
        workspaceLookup: options.workspaceLookup,
      })
    ) {
      addPackageImportRelativeScopeProblem({
        config: options.config,
        importRecord: options.importRecord,
        owner: options.owner,
        packageScope,
        problems: options.problems,
        resolvedFilePath: options.resolvedFilePath,
        targetPackageScope: options.workspaceLookup.findNearestPackageScopeInfo(
          options.resolvedFilePath,
        ),
      });
    }
    return;
  }

  if (target.kind === 'other-owner') {
    if (shouldTreatPackageImportAsPackageTarget(match)) {
      addPackageImportArtifactAuthorizationProblem({
        config: options.config,
        importAuthorityAllowRules: options.importAuthorityAllowRules,
        importRecord: options.importRecord,
        owner: options.owner,
        packages: options.packages,
        packageInfo: target.packageInfo,
        problems: options.problems,
        rootPackage: options.rootPackage,
        workspacePackage: target.workspacePackage,
      });
      return;
    }

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
    addPackageImportArtifactAuthorizationProblem({
      config: options.config,
      importAuthorityAllowRules: options.importAuthorityAllowRules,
      importRecord: options.importRecord,
      owner: options.owner,
      packages: options.packages,
      packageInfo: target.packageInfo,
      problems: options.problems,
      rootPackage: options.rootPackage,
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
  ownerRootDir: string;
}): TsconfigOwnershipResolution {
  const candidatePaths = collectBareTsconfigPathCandidates({
    filePath: options.fileName,
    rootDir: options.ownerRootDir,
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
      '  fix: make one tsconfig.json between the module directory and its activated package-island root include the module, or make its ordinary typecheck references reach exactly one owner tsconfig.',
    ].join('\n'),
  );
}

async function addTsconfigGovernanceProblems(options: {
  ambientDeclarations: AmbientDeclarationIndex;
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  configPaths: string[];
  generatedGraph: GeneratedTsconfigGraphResult;
  problems: string[];
  workspaceLookup: WorkspaceLookupIndex;
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
  const ambientConsumersByFile = new Map<
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

    const owner = options.workspaceLookup.findOwnerForFile(configPath);

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
      const ambientPolicy = options.ambientDeclarations.get(fileName);

      if (ambientPolicy) {
        const consumers = ambientConsumersByFile.get(fileName) ?? new Map();
        const consumer = consumers.get(owner.packageJsonPath) ?? {
          configPaths: [],
          owner,
        };

        consumer.configPaths.push(configPath);
        consumers.set(owner.packageJsonPath, consumer);
        ambientConsumersByFile.set(fileName, consumers);
        continue;
      }

      const fileOwner = options.workspaceLookup.findOwnerForFile(fileName);

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

  for (const [fileName, consumers] of [
    ...ambientConsumersByFile.entries(),
  ].sort(([left], [right]) => left.localeCompare(right))) {
    options.checks.add();
    const policy = options.ambientDeclarations.get(fileName);

    if (!policy || consumers.size <= 1 || policy.allowSharedAcrossOwners) {
      continue;
    }

    options.problems.push(
      [
        'Ambient declaration is shared across source owners without authorization:',
        `  file: ${toRelativePath(options.config.rootDir, fileName)}`,
        `  rule: source.declarations.ambient[${policy.ruleIndex}]`,
        '  source owners:',
        ...[...consumers.values()]
          .sort((left, right) =>
            left.owner.packageJsonPath.localeCompare(
              right.owner.packageJsonPath,
            ),
          )
          .flatMap((consumer) => [
            `    - ${toRelativePath(options.config.rootDir, consumer.owner.packageJsonPath)}`,
            ...consumer.configPaths
              .sort((left, right) => left.localeCompare(right))
              .map(
                (consumerConfigPath) =>
                  `      config: ${toRelativePath(options.config.rootDir, consumerConfigPath)}`,
              ),
          ]),
        `  configured reason: ${policy.reason}`,
        '  reason: more than one distinct source owner consumes this ambient declaration, but allowSharedAcrossOwners is false.',
        '  fix: set allowSharedAcrossOwners: true or narrow the ambient include and consuming tsconfig file sets.',
      ].join('\n'),
    );
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
      ownerRootDir: [...governanceUnits.values()][0]!.owner.directory,
    });

    if (ownershipResolution.status === 'missing') {
      addNearestTsconfigOwnershipProblem({
        config: options.config,
        fileName,
        matchedOwnerConfigPaths: ownershipResolution.matchedOwnerConfigPaths,
        problems: options.problems,
        reason:
          'no tsconfig.json was found between the module directory and its activated package-island root.',
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
            ? 'no tsconfig.json between the module directory and its activated package-island root includes the module or reaches one ordinary typecheck config that includes it.'
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
    entryPatternsByOwnerName: new Map(
      options.ownerModuleSets.flatMap((moduleSet) => {
        const ownerName = moduleSet.owner.name;

        if (!ownerName) {
          return [];
        }

        return [
          [
            ownerName,
            uniqueSortedStrings([
              ...(unusedModuleConfig.entryPatternsByOwnerName.get(ownerName) ??
                []),
              ...collectGeneratedArtifactSourceEntryPatterns({
                generatedGraph: options.generatedGraph,
                moduleSet,
              }),
            ]),
          ] as const,
        ];
      }),
    ),
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
  core: AnalysisProviderSet,
  projects: ProjectInfo[],
  workspaceLookup: WorkspaceLookupIndex,
): Promise<SourceProjectEntry[]> {
  return Promise.all(
    projects
      .filter((project) => isDtsProjectConfig(project.configPath))
      .map(async (project) => {
        const typecheckConfigPath = project.resolverConfigPath;
        const fileNames = new Set(project.fileNames);

        if (existsSync(typecheckConfigPath)) {
          for (const fileName of (
            await core.tsconfig.getProject(typecheckConfigPath, project)
          ).fileNames) {
            fileNames.add(fileName);
          }
        }

        return {
          fileNames: [...fileNames]
            .filter((fileName) =>
              workspaceLookup.isInsideActivatedRegion(fileName),
            )
            .sort(),
          project,
        };
      }),
  );
}

async function addSourceProjectOwnerProblems(options: {
  ambientDeclarations: AmbientDeclarationIndex;
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  providers: AnalysisProviderSet;
  problems: string[];
  projects: ProjectInfo[];
  workspaceLookup: WorkspaceLookupIndex;
}): Promise<void> {
  for (const project of options.projects) {
    if (project.labelProblem) {
      options.problems.push(project.labelProblem);
    }

    if (!isDtsProjectConfig(project.configPath)) {
      continue;
    }

    addProjectOwnerProblems({
      ambientDeclarations: options.ambientDeclarations,
      checks: options.checks,
      config: options.config,
      configPath: project.configPath,
      fileNames: project.fileNames,
      problems: options.problems,
      role: 'declaration leaf',
      workspaceLookup: options.workspaceLookup,
    });

    const typecheckConfigPath = project.resolverConfigPath;

    if (!existsSync(typecheckConfigPath)) {
      continue;
    }

    addProjectOwnerProblems({
      ambientDeclarations: options.ambientDeclarations,
      checks: options.checks,
      config: options.config,
      configPath: typecheckConfigPath,
      fileNames: (
        await options.providers.tsconfig.getProject(
          typecheckConfigPath,
          project,
        )
      ).fileNames,
      problems: options.problems,
      role: 'typecheck companion',
      workspaceLookup: options.workspaceLookup,
    });
  }
}

function addRelativeImportProblems(options: {
  ambientDeclarations: AmbientDeclarationIndex;
  config: ResolvedLiminaConfig;
  filePath: string;
  importRecord: ImportRecord;
  owner: PackageOwner;
  problems: string[];
  resolvedFilePath: string | null;
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  if (!options.resolvedFilePath) {
    return;
  }

  if (options.importRecord.kind === 'triple-slash-path') {
    const policy = options.ambientDeclarations.get(options.resolvedFilePath);

    if (policy?.allowTripleSlashReferences) {
      return;
    }

    if (policy) {
      options.problems.push(
        [
          'Ambient declaration triple-slash path reference is not authorized:',
          `  source owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
          `  file: ${toRelativePath(options.config.rootDir, options.filePath)}:${options.importRecord.line}`,
          `  declaration target: ${toRelativePath(options.config.rootDir, options.resolvedFilePath)}`,
          `  rule: source.declarations.ambient[${policy.ruleIndex}]`,
          '  reason: allowTripleSlashReferences is false for the matched ambient declaration rule.',
          '  fix: set allowTripleSlashReferences: true or remove the triple-slash path reference.',
        ].join('\n'),
      );
      return;
    }
  }

  const sourcePackageScope =
    options.workspaceLookup.findNearestPackageScopeInfo(options.filePath);
  const targetPackageScope =
    options.workspaceLookup.findNearestPackageScopeInfo(
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
  const isCommentDependency =
    importRecord.kind === 'jsdoc-import' ||
    importRecord.kind === 'triple-slash-path' ||
    importRecord.kind === 'triple-slash-types' ||
    importRecord.kind === 'jsx-import-source' ||
    importRecord.kind === 'environment-pragma';

  return (
    isUrlOrDataOrFileSpecifier(importRecord.specifier) ||
    isVirtualModuleSpecifier(importRecord.specifier) ||
    !isBarePackageSpecifier(importRecord.specifier) ||
    isCommentDependency ||
    isNodeBuiltinSpecifier(importRecord.specifier)
  );
}

function addResolvedOtherOwnerBarePackageProblems(options: {
  config: ResolvedLiminaConfig;
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  packages: WorkspacePackage[];
  problems: string[];
  rootPackage: WorkspacePackage | null;
  target: Extract<ResolvedPackageTarget, { kind: 'other-owner' }>;
}): void {
  const resolvedPackageName =
    options.target.packageInfo.name ?? options.target.targetOwner.name;

  if (!resolvedPackageName) {
    addResolvedPackageWithoutNameProblem({
      config: options.config,
      importRecord: options.importRecord,
      owner: options.owner,
      packageInfo: options.target.packageInfo,
      problems: options.problems,
    });
    return;
  }

  const authorityTarget = getBarePackageImportAuthorityTarget({
    importRecord: options.importRecord,
    resolvedPackageName,
  });
  const resolvedPackageNameDiagnostic =
    getResolvedPackageNameDiagnostic(authorityTarget);
  const authorization = resolvePackageImportAuthorization({
    config: options.config,
    importAuthorityAllowRules: options.importAuthorityAllowRules,
    importRecord: options.importRecord,
    owner: options.owner,
    packageName: authorityTarget.requestedPackageName,
    packages: options.packages,
    rootPackage: options.rootPackage,
  });

  if (authorization.authorized) {
    return;
  }

  addPackageImportAuthorizationProblem({
    authorization,
    config: options.config,
    ...(resolvedPackageNameDiagnostic
      ? { dependencySpecifier: resolvedPackageNameDiagnostic }
      : {}),
    importRecord: options.importRecord,
    owner: options.owner,
    packageName: authorityTarget.requestedPackageName,
    problems: options.problems,
    workspacePackage: options.target.workspacePackage,
  });
}

function addResolvedArtifactBarePackageProblems(options: {
  config: ResolvedLiminaConfig;
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  packages: WorkspacePackage[];
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

  const authorityTarget = getBarePackageImportAuthorityTarget({
    importRecord: options.importRecord,
    resolvedPackageName: options.target.packageInfo.name,
  });
  const resolvedPackageNameDiagnostic =
    getResolvedPackageNameDiagnostic(authorityTarget);
  const authorization = resolvePackageImportAuthorization({
    config: options.config,
    importAuthorityAllowRules: options.importAuthorityAllowRules,
    importRecord: options.importRecord,
    owner: options.owner,
    packageName: authorityTarget.requestedPackageName,
    packages: options.packages,
    rootPackage: options.rootPackage,
  });

  if (authorization.authorized) {
    return;
  }

  addPackageImportAuthorizationProblem({
    authorization,
    config: options.config,
    ...(resolvedPackageNameDiagnostic
      ? { dependencySpecifier: resolvedPackageNameDiagnostic }
      : {}),
    importRecord: options.importRecord,
    owner: options.owner,
    packageName: authorityTarget.requestedPackageName,
    problems: options.problems,
    workspacePackage: null,
  });
}

function addResolvedBarePackageImportProblems(options: {
  config: ResolvedLiminaConfig;
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  packages: WorkspacePackage[];
  problems: string[];
  resolvedFilePath: string;
  rootPackage: WorkspacePackage | null;
  workspaceLookup: WorkspaceLookupIndex;
}): boolean {
  const target = options.workspaceLookup.classifyResolvedPackageTarget({
    owner: options.owner,
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
      packages: options.packages,
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
      packages: options.packages,
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
  packages: WorkspacePackage[];
  problems: string[];
  resolvedFilePath: string | null;
  rootPackage: WorkspacePackage | null;
  workspaceLookup: WorkspaceLookupIndex;
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
      packages: options.packages,
      problems: options.problems,
      resolvedFilePath: options.resolvedFilePath,
      rootPackage: options.rootPackage,
      workspaceLookup: options.workspaceLookup,
    })
  ) {
    return;
  }

  const workspacePackage =
    options.packages.find(
      (candidate) => candidate.name === options.fallbackPackageName,
    ) ?? null;
  const authorization = resolvePackageImportAuthorization({
    config: options.config,
    importAuthorityAllowRules: options.importAuthorityAllowRules,
    importRecord: options.importRecord,
    owner: options.owner,
    packageName: options.fallbackPackageName,
    packages: options.packages,
    rootPackage: options.rootPackage,
  });

  if (authorization.authorized) {
    return;
  }

  addPackageImportAuthorizationProblem({
    authorization,
    config: options.config,
    importRecord: options.importRecord,
    owner: options.owner,
    packageName: options.fallbackPackageName,
    problems: options.problems,
    workspacePackage,
  });
}

function addImportRecordProblems(options: {
  ambientDeclarations: AmbientDeclarationIndex;
  config: ResolvedLiminaConfig;
  filePath: string;
  importAnalysis: AnalysisProviderSet['imports']['context'];
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  packages: WorkspacePackage[];
  pathIndex: WorkspaceRegionPathIndex;
  problems: string[];
  project: ProjectInfo;
  rootPackage: WorkspacePackage | null;
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const resolvedFilePath = resolveInternalImport(
    options.importRecord.specifier,
    options.filePath,
    options.project.options,
    options.project,
    options.importAnalysis,
  );
  const targetRegionBoundary = resolvedFilePath
    ? options.pathIndex.findBoundaryForPath(resolvedFilePath)
    : null;

  if (resolvedFilePath && targetRegionBoundary) {
    addSourceCrossGovernanceBoundaryProblem({
      boundary: targetRegionBoundary,
      config: options.config,
      importRecord: options.importRecord,
      owner: options.owner,
      problems: options.problems,
      resolvedFilePath,
    });
    return;
  }

  if (
    resolvedFilePath &&
    options.workspaceLookup.isLocalPathOutsideActivatedRegion(resolvedFilePath)
  ) {
    addSourceImportOutsideActivatedRegionProblem({
      config: options.config,
      importRecord: options.importRecord,
      owner: options.owner,
      problems: options.problems,
      resolvedFilePath,
    });
    return;
  }

  if (isRelativeSpecifier(options.importRecord.specifier)) {
    addRelativeImportProblems({
      ambientDeclarations: options.ambientDeclarations,
      config: options.config,
      filePath: options.filePath,
      importRecord: options.importRecord,
      owner: options.owner,
      problems: options.problems,
      resolvedFilePath,
      workspaceLookup: options.workspaceLookup,
    });
    return;
  }

  if (isPackageImportSpecifier(options.importRecord.specifier)) {
    addPackageImportProblem({
      config: options.config,
      importRecord: options.importRecord,
      owner: options.owner,
      packages: options.packages,
      problems: options.problems,
      resolvedFilePath,
      importAuthorityAllowRules: options.importAuthorityAllowRules,
      rootPackage: options.rootPackage,
      workspaceLookup: options.workspaceLookup,
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
    packages: options.packages,
    problems: options.problems,
    resolvedFilePath,
    rootPackage: options.rootPackage,
    workspaceLookup: options.workspaceLookup,
  });
}

function addSourceImportProblems(options: {
  ambientDeclarations: AmbientDeclarationIndex;
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  importAnalysis: AnalysisProviderSet['imports']['context'];
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
  packages: WorkspacePackage[];
  pathIndex: WorkspaceRegionPathIndex;
  problems: string[];
  rootPackage: WorkspacePackage | null;
  sourceProjectEntries: SourceProjectEntry[];
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  for (const { fileNames, project } of options.sourceProjectEntries) {
    for (const filePath of fileNames) {
      const owner = options.workspaceLookup.findOwnerForFile(filePath);

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
          ambientDeclarations: options.ambientDeclarations,
          config: options.config,
          filePath,
          importAnalysis: options.importAnalysis,
          importAuthorityAllowRules: options.importAuthorityAllowRules,
          importRecord,
          owner,
          packages: options.packages,
          pathIndex: options.pathIndex,
          problems: options.problems,
          project,
          rootPackage: options.rootPackage,
          workspaceLookup: options.workspaceLookup,
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
  if (title.startsWith('Ambient declaration configuration')) {
    return LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationConfigInvalid;
  }

  if (title.startsWith('Ambient declaration is shared across source owners')) {
    return LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationSharedUnauthorized;
  }

  if (title.startsWith('Ambient declaration triple-slash path reference')) {
    return LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationReferenceUnauthorized;
  }

  if (title.startsWith('Source import crosses governance boundary')) {
    return LIMINA_CHECK_ISSUE_CODES.sourceCrossGovernanceBoundary;
  }

  if (
    title.startsWith(
      'Source import resolves outside activated workspace package regions',
    )
  ) {
    return LIMINA_CHECK_ISSUE_CODES.sourceOwnerInvalid;
  }

  if (
    title.startsWith('Nested pnpm workspace root') ||
    title.includes('workspace region')
  ) {
    return LIMINA_CHECK_ISSUE_CODES.workspaceRegionOverlap;
  }

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
    providers?: AnalysisProviderSet;
    generatedGraphProvider?: () => Promise<GeneratedTsconfigGraphResult>;
    knipRunner?: KnipCliRunner;
    deferSnapshot?: boolean;
    logSuccess?: boolean;
    onStats?: (stats: LiminaCheckRunTaskStats) => void;
    onSourceSnapshot?: (issues: readonly SourceCheckIssue[]) => void;
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
  const core = preflight.providers;
  const generatedGraph = await preflight.ensureGeneratedGraph();
  const graphRoute = await preflight.ensureSourceGraphProjectExtensions();
  const projectPaths = [...graphRoute.projectExtensionsByPath.keys()].sort();
  const workspaceLookup = await preflight.ensureWorkspaceLookupIndex();
  const projects = (
    await Promise.all(
      projectPaths.map((projectPath) =>
        core.tsconfig.getProject(
          projectPath,
          graphRoute.projectContextsByPath.get(projectPath),
        ),
      ),
    )
  ).map((project) =>
    filterProjectInfoToActivatedRegion(project, workspaceLookup),
  );
  const sourceProjectEntries = await createSourceProjectEntries(
    core,
    projects,
    workspaceLookup,
  );
  const packages = await preflight.ensureWorkspacePackages();
  const workspaceContext = await preflight.ensureWorkspaceValidated();
  const workspacePathIndex = new WorkspaceRegionPathIndex(workspaceContext);
  const packageOwners = await preflight.ensurePackageOwners();
  const workspaceDependencyDeclarations =
    await preflight.ensureWorkspaceDependencyDeclarations();
  const rootPackage = findWorkspaceRootPackage({
    config,
    packages,
  });
  const ownerModuleSets = collectOwnerSourceModuleSets({
    sourceProjectEntries,
    workspaceLookup,
  });
  const importAnalysis = preflight.importAnalysis;
  const ambientDeclarationResult = await createAmbientDeclarationIndex({
    config,
    generatedGraph,
    workspaceContext,
    workspacePathIndex,
  });

  sourceIssues.push(...ambientDeclarationResult.issues);

  checkItems.start('source graph routes');
  problems.push(...graphRoute.problems);
  checks.add(projectPaths.length);
  checkItems.record('source graph routes');

  checkItems.start('tsconfig governance');
  await addTsconfigGovernanceProblems({
    ambientDeclarations: ambientDeclarationResult.index,
    checks,
    config,
    configPaths: collectGeneratedSourceConfigPaths(generatedGraph),
    generatedGraph,
    problems,
    workspaceLookup,
  });
  checkItems.record('tsconfig governance');

  checkItems.start('knip source usage');
  try {
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
  } catch (error) {
    if (!isLiminaOptionalToolMissingError(error)) {
      throw error;
    }

    checkItems.skip(
      'knip source usage',
      formatMissingOptionalToolSkipMessage(error.toolName),
    );
  }

  checkItems.start('source project ownership');
  await addSourceProjectOwnerProblems({
    ambientDeclarations: ambientDeclarationResult.index,
    checks,
    config,
    providers: core,
    problems,
    projects,
    workspaceLookup,
  });
  checkItems.record('source project ownership');

  checkItems.start('source import authority');
  const importAuthorityAllowRules = collectImportAuthorityAllowRules({
    checks,
    config,
    problems,
  });
  addImportAuthorityOwnerConfigProblems({
    checks,
    config,
    ownerIdentities: new Set(
      packageOwners.map((owner) =>
        getSourceOwnerIdentity({
          config,
          owner,
        }),
      ),
    ),
    problems,
  });
  addImportAuthorityRootManifestConfigProblems({
    checks,
    config,
    importAuthorityAllowRules,
    problems,
  });

  addSourceImportProblems({
    ambientDeclarations: ambientDeclarationResult.index,
    checks,
    config,
    importAnalysis,
    importAuthorityAllowRules,
    packages,
    pathIndex: workspacePathIndex,
    problems,
    rootPackage,
    sourceProjectEntries,
    workspaceLookup,
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
  options.onSourceSnapshot?.(structuredSourceIssues);

  if (!options.deferSnapshot) {
    await writeCompletedStandaloneSourceCheckSnapshots({
      artifactNamespace: preflight.artifactNamespace,
      command: options.report?.command ?? 'limina source check',
      issues: structuredSourceIssues,
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
