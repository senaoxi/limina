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
import { shouldUseColor } from '#utils/reporting';
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
import type { WorkspaceRegionPathIndex } from '../core/workspace/validated-context';
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
  createSourceUnusedModuleFinding,
  createSourceUnusedWorkspaceDependencyFinding,
  type SourceFinding,
  type SourceFindingFactsByCode,
  type SourceFindingForCode,
  type SourceStructuredIssueCode,
} from './findings';
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
  type SourceCheckIssue,
  type SourceIssueReportOptions,
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
  checkerNames: string[];
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

function createSourceDiagnosticFinding<
  Code extends SourceStructuredIssueCode,
>(options: {
  checkerName?: string;
  code: Code;
  detailLines?: readonly string[];
  external?: SourceFindingForCode<Code>['external'];
  facts: SourceFindingFactsByCode[Code];
  filePath?: string;
  fix?: string;
  lines: readonly string[];
  locations?: SourceFindingForCode<Code>['locations'];
  ownerName?: string;
  packageJsonPath?: string;
  reason: string;
  scope?: string;
  title: string;
  tool?: string;
}): SourceFindingForCode<Code> {
  return {
    checkerName: options.checkerName,
    code: options.code,
    detailLines: options.detailLines,
    detector: 'source',
    evidence: [{ label: 'diagnostic', lines: [...options.lines] }],
    external: options.external,
    facts: options.facts,
    filePath: options.filePath,
    fix: options.fix,
    fixSteps: options.fix ? [options.fix] : undefined,
    locations: options.locations,
    ownerName: options.ownerName ?? '<workspace>',
    packageJsonPath: options.packageJsonPath,
    reason: options.reason,
    scope: options.scope,
    summary: options.title,
    task: 'source:check',
    title: options.title,
    tool: options.tool ?? 'limina',
    verifyCommands: ['limina source check'],
  } as SourceFindingForCode<Code>;
}

function addProjectOwnerProblems(options: {
  ambientDeclarations: AmbientDeclarationIndex;
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  configPath: string;
  fileNames: string[];
  findings: SourceFinding[];
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
    const title = 'Source file has no source owner';
    const reason =
      'every source file checked by Limina must be governed by a pnpm workspace source owner.';
    const lines = [
      `${title}:`,
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
      `  reason: ${reason}`,
    ];
    options.findings.push(
      createSourceDiagnosticFinding({
        code: LIMINA_CHECK_ISSUE_CODES.sourceOwnerInvalid,
        facts: {
          configPath: options.configPath,
          filePaths: missingOwnerFiles,
          kind: 'missing-owner',
          role: options.role,
        },
        filePath: options.configPath,
        lines,
        reason,
        title,
      }),
    );
  }

  if (ownerPaths.size <= 1) {
    return;
  }

  const title = 'Tsconfig source file set mixes source owners';
  const reason =
    'non-aggregator tsconfig leaves and their companion typecheck configs must stay within one pnpm workspace source owner scope.';
  const ownerManifestPaths = [...ownerPaths.keys()];
  const lines = [
    `${title}:`,
    `  ${options.role}: ${toRelativePath(options.config.rootDir, options.configPath)}`,
    '  source owners:',
    ...ownerManifestPaths.map(
      (packageJsonPath) =>
        `    - ${toRelativePath(options.config.rootDir, packageJsonPath)}`,
    ),
    `  reason: ${reason}`,
  ];
  options.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance,
      facts: {
        configPath: options.configPath,
        kind: 'config-mixed-owners',
        packageManifestPaths: ownerManifestPaths,
        role: options.role,
      },
      filePath: options.configPath,
      lines,
      reason,
      title,
    }),
  );
}

function addRelativeImportOwnerProblem(options: {
  config: ResolvedLiminaConfig;
  importRecord: ImportRecord;
  owner: PackageOwner;
  findings: SourceFinding[];
  resolvedFilePath: string;
  sourcePackageScope: NearestPackageInfo | null;
  targetPackageScope: NearestPackageInfo | null;
}): void {
  const title = 'Relative import escapes package scope';
  const reason =
    'relative source imports must not cross the nearest package.json package boundary.';
  const lines = [
    `${title}:`,
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
    `  reason: ${reason}`,
  ];
  options.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourceRelativeImportEscapesScope,
      facts: {
        importerPath: options.importRecord.filePath,
        kind: 'relative-import',
        line: options.importRecord.line,
        packageManifestPath: options.owner.packageJsonPath,
        packageName: options.owner.name ?? undefined,
        packageScopeManifestPath:
          options.sourcePackageScope?.packageJsonPath ?? undefined,
        resolvedTargetPath: options.resolvedFilePath,
        specifier: options.importRecord.specifier,
        targetPackageManifestPath:
          options.targetPackageScope?.packageJsonPath ?? undefined,
      },
      filePath: options.importRecord.filePath,
      lines,
      ownerName: options.owner.name ?? undefined,
      packageJsonPath: options.owner.packageJsonPath,
      reason,
      title,
    }),
  );
}

function addSourceCrossGovernanceBoundaryProblem(options: {
  boundary: WorkspaceRegionBoundary;
  config: ResolvedLiminaConfig;
  importRecord: ImportRecord;
  owner: PackageOwner;
  findings: SourceFinding[];
  resolvedFilePath: string;
}): void {
  const exclusionReason = getWorkspaceRegionBoundaryExclusionReason(
    options.boundary,
  );

  const title = 'Source import crosses governance boundary';
  const reason =
    'current-region source must not import source files beyond a stopped or excluded governance boundary during a single Limina run.';
  const fix =
    'remove the cross-boundary source import, activate an eligible package scope, or consume a published package artifact instead of local source.';
  const boundaryConfigPath =
    options.boundary.kind === 'pnpm-workspace'
      ? options.boundary.workspaceYamlPath
      : options.boundary.packageJsonPath;
  const lines = [
    `${title}:`,
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
    `  reason: ${reason}`,
    `  fix: ${fix}`,
  ];
  options.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourceCrossGovernanceBoundary,
      facts: {
        boundary: {
          configPath: boundaryConfigPath,
          exclusion: exclusionReason ?? undefined,
          kind: options.boundary.kind,
          rootDir: options.boundary.rootDir,
        },
        importerPath: options.importRecord.filePath,
        kind: 'cross-governance-boundary',
        line: options.importRecord.line,
        packageManifestPath: options.owner.packageJsonPath,
        packageName: options.owner.name ?? undefined,
        resolvedTargetPath: options.resolvedFilePath,
        specifier: options.importRecord.specifier,
      },
      filePath: options.importRecord.filePath,
      fix,
      lines,
      ownerName: options.owner.name ?? undefined,
      packageJsonPath: options.owner.packageJsonPath,
      reason,
      title,
    }),
  );
}

function addSourceImportOutsideActivatedRegionProblem(options: {
  config: ResolvedLiminaConfig;
  importRecord: ImportRecord;
  owner: PackageOwner;
  findings: SourceFinding[];
  resolvedFilePath: string;
}): void {
  const title =
    'Source import resolves outside activated workspace package regions';
  const reason =
    'current-run source governance is bounded by activated workspace packages; local repo files outside those packages cannot be imported as governed source.';
  const fix =
    'move the target into an activated workspace package, activate the owning package for this run, or consume it as a package artifact instead of a local source file.';
  const lines = [
    `${title}:`,
    `  source owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
    `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  resolved file: ${toRelativePath(options.config.rootDir, options.resolvedFilePath)}`,
    `  reason: ${reason}`,
    `  fix: ${fix}`,
  ];
  options.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourceOwnerInvalid,
      facts: {
        importerPath: options.importRecord.filePath,
        kind: 'outside-activated-region',
        line: options.importRecord.line,
        packageManifestPath: options.owner.packageJsonPath,
        packageName: options.owner.name ?? undefined,
        resolvedTargetPath: options.resolvedFilePath,
        specifier: options.importRecord.specifier,
      },
      filePath: options.importRecord.filePath,
      fix,
      lines,
      ownerName: options.owner.name ?? undefined,
      packageJsonPath: options.owner.packageJsonPath,
      reason,
      title,
    }),
  );
}

function addPackageImportAuthorizationProblem(options: {
  authorization: PackageImportAuthorizationResolution;
  config: ResolvedLiminaConfig;
  dependencySpecifier?: string;
  importRecord: ImportRecord;
  owner: PackageOwner;
  packageName: string;
  findings: SourceFinding[];
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

  const reason = options.authorization.intermediateDependencyPackage
    ? `source import authority can only use the owner package.json or an explicitly configured workspace root dependency grant. An intermediate workspace package declares "${options.packageName}", so the workspace root grant must not bypass it.`
    : rootManifestDoesNotDeclarePackage
      ? `the grant allows workspace root dependency authority, but the workspace root package.json does not declare "${options.packageName}".`
      : 'source imports must be declared by the nearest pnpm workspace source owner or by an explicitly configured workspace root dependency grant.';
  const title = 'Unauthorized bare package import';
  const lines = [
    `${title}:`,
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
          `  reason: ${reason}`,
          '  intermediate dependency declaration:',
          `    package.json: ${toRelativePath(
            options.config.rootDir,
            getWorkspacePackageJsonPath(
              options.authorization.intermediateDependencyPackage,
            ),
          )}`,
        ]
      : rootManifestDoesNotDeclarePackage
        ? [`  reason: ${reason}`]
        : [`  reason: ${reason}`]),
    `  fix: ${fix}`,
  ];
  options.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourcePackageImportUnauthorized,
      facts: {
        authorityManifestPaths: options.authorization.authorityManifestPaths,
        authorityReason: options.authorization.matchedGrant?.reason,
        dependencyName: options.packageName,
        dependencySpecifier: options.dependencySpecifier,
        importerPath: options.importRecord.filePath,
        intermediateDependencyName:
          options.authorization.intermediateDependencyPackage?.name ??
          undefined,
        kind: 'bare-package-import',
        line: options.importRecord.line,
        ownerIdentity,
        packageManifestPath: options.owner.packageJsonPath,
        packageName: options.owner.name ?? undefined,
        specifier: options.importRecord.specifier,
        workspacePackageName: options.workspacePackage?.name ?? undefined,
      },
      filePath: options.importRecord.filePath,
      fix,
      lines,
      ownerName: options.owner.name ?? undefined,
      packageJsonPath: options.owner.packageJsonPath,
      reason,
      title,
    }),
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

function addImportAuthorityConfigFinding(options: {
  field: string;
  findings: SourceFinding[];
  fix?: string;
  grantIndex?: number;
  kind: SourceFindingFactsByCode[typeof LIMINA_CHECK_ISSUE_CODES.sourceImportAuthorityInvalid]['kind'];
  ownerIdentity?: string;
  packageJsonPath?: string;
  reason: string;
  suggestion?: string;
  value?: unknown;
  valueLines?: readonly string[];
}): void {
  const title = 'Invalid source import authority config';
  const lines = [
    `${title}:`,
    `  field: ${options.field}`,
    ...(options.valueLines ?? []),
    `  reason: ${options.reason}`,
    ...(options.fix ? [`  fix: ${options.fix}`] : []),
    ...(options.suggestion
      ? ['  did you mean:', `    - ${options.suggestion}`]
      : []),
  ];
  options.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourceImportAuthorityInvalid,
      facts: {
        field: options.field,
        grantIndex: options.grantIndex,
        kind: options.kind,
        ownerIdentity: options.ownerIdentity,
        packageManifestPath: options.packageJsonPath,
        suggestion: options.suggestion,
        value: options.value,
      },
      fix: options.fix,
      lines,
      locations: [{ label: 'field', scope: options.field }],
      ownerName: options.ownerIdentity,
      packageJsonPath: options.packageJsonPath,
      reason: options.reason,
      scope: options.field,
      title,
    }),
  );
}

function addImportAuthorityOwnerConfigProblems(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  findings: SourceFinding[];
  ownerIdentities: Set<string>;
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

    addImportAuthorityConfigFinding({
      field: `source.importAuthority.allow[${JSON.stringify(ownerKey)}]`,
      findings: options.findings,
      fix: 'use an existing workspace package name, or the config-root-relative owner directory for nameless owners.',
      kind: 'unknown-owner',
      ownerIdentity: ownerKey,
      reason: getImportAuthorityOwnerKeyReason(ownerKey),
      suggestion,
      valueLines: [`  owner: ${ownerKey}`],
    });
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
  findings: SourceFinding[];
}): CompiledImportAuthorityAllowRule[] {
  const rawAllow = options.config.source?.importAuthority?.allow;

  if (rawAllow === undefined) {
    return [];
  }

  if (Array.isArray(rawAllow) || !isPlainConfigRecord(rawAllow)) {
    options.checks.add();
    addImportAuthorityConfigFinding({
      field: 'source.importAuthority.allow',
      findings: options.findings,
      fix: 'use allow: { "@scope/package": [{ include: ["test/**/*.ts"], workspaceRootDependencies: ["@example/fixture"], reason: "..." }] }.',
      kind: 'allow-field',
      reason: 'allow must be an object keyed by source owner identity.',
      value: rawAllow,
    });
    return [];
  }

  const rules: CompiledImportAuthorityAllowRule[] = [];

  for (const [ownerIdentity, grants] of Object.entries(rawAllow)) {
    options.checks.add();

    if (!Array.isArray(grants)) {
      addImportAuthorityConfigFinding({
        field: `source.importAuthority.allow[${JSON.stringify(ownerIdentity)}]`,
        findings: options.findings,
        kind: 'grant',
        ownerIdentity,
        reason: 'allow owner entries must be arrays of grants.',
        value: grants,
      });
      continue;
    }

    for (const [grantIndex, grant] of grants.entries()) {
      options.checks.add();

      if (!isPlainConfigRecord(grant)) {
        addImportAuthorityConfigFinding({
          field: `source.importAuthority.allow[${JSON.stringify(ownerIdentity)}][${grantIndex}]`,
          findings: options.findings,
          grantIndex,
          kind: 'grant',
          ownerIdentity,
          reason:
            'importAuthority allow grants must be objects with workspaceRootDependencies and reason fields.',
          value: grant,
        });
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
        addImportAuthorityConfigFinding({
          field: `source.importAuthority.allow[${JSON.stringify(ownerIdentity)}][${grantIndex}].include`,
          findings: options.findings,
          grantIndex,
          kind: 'grant-include',
          ownerIdentity,
          reason: 'include must be a non-empty string array when configured.',
          value: grant.include,
        });
        continue;
      }

      if (invalidInclude) {
        addImportAuthorityConfigFinding({
          field: `source.importAuthority.allow[${JSON.stringify(ownerIdentity)}][${grantIndex}].include`,
          findings: options.findings,
          grantIndex,
          kind: 'grant-include',
          ownerIdentity,
          reason: 'include must use positive config-root-relative globs.',
          value: invalidInclude,
          valueLines: [`  file: ${invalidInclude}`],
        });
        continue;
      }

      if (
        !Array.isArray(grant.workspaceRootDependencies) ||
        grant.workspaceRootDependencies.length === 0 ||
        grant.workspaceRootDependencies.some(
          (value) => typeof value !== 'string' || value.trim().length === 0,
        )
      ) {
        addImportAuthorityConfigFinding({
          field: `source.importAuthority.allow[${JSON.stringify(ownerIdentity)}][${grantIndex}].workspaceRootDependencies`,
          findings: options.findings,
          grantIndex,
          kind: 'grant-packages',
          ownerIdentity,
          reason: 'workspaceRootDependencies must be a non-empty string array.',
          value: grant.workspaceRootDependencies,
        });
        continue;
      }

      if (
        typeof grant.reason !== 'string' ||
        grant.reason.trim().length === 0
      ) {
        addImportAuthorityConfigFinding({
          field: `source.importAuthority.allow[${JSON.stringify(ownerIdentity)}][${grantIndex}].reason`,
          findings: options.findings,
          grantIndex,
          kind: 'grant-reason',
          ownerIdentity,
          reason: 'reason must be a non-empty string.',
          value: grant.reason,
        });
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
  findings: SourceFinding[];
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
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

  addImportAuthorityConfigFinding({
    field: 'source.importAuthority.allow',
    findings: options.findings,
    fix: 'create a workspace root package.json, or remove workspaceRootDependencies grants.',
    kind: 'root-dependency-grants',
    packageJsonPath: rootPackageJsonPath,
    reason:
      'workspaceRootDependencies grants require a workspace root package.json.',
  });
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
  findings: SourceFinding[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  packageInfo: NearestPackageInfo;
}): void {
  const title = 'Resolved package import has no package name';
  const reason =
    'source imports can only be authorized against a named package.json dependency.';
  const lines = [
    `${title}:`,
    `  source owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
    `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  resolved package.json: ${toRelativePath(options.config.rootDir, options.packageInfo.packageJsonPath)}`,
    `  reason: ${reason}`,
  ];
  options.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourcePackageImportInvalid,
      facts: {
        importerPath: options.importRecord.filePath,
        kind: 'resolved-package-name-missing',
        line: options.importRecord.line,
        packageManifestPath: options.owner.packageJsonPath,
        packageName: options.owner.name ?? undefined,
        resolvedPackageManifestPath: options.packageInfo.packageJsonPath,
        specifier: options.importRecord.specifier,
      },
      filePath: options.importRecord.filePath,
      lines,
      ownerName: options.owner.name ?? undefined,
      packageJsonPath: options.owner.packageJsonPath,
      reason,
      title,
    }),
  );
}

function addPackageImportOtherOwnerProblem(options: {
  config: ResolvedLiminaConfig;
  findings: SourceFinding[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  resolvedFilePath: string;
  targetOwner: PackageOwner;
  workspacePackage: WorkspacePackage | null;
}): void {
  const title = 'Package import resolves to another source owner';
  const reason =
    '#... package imports must not resolve to modules governed by another source owner.';
  const lines = [
    `${title}:`,
    `  source owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
    `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  target source owner: ${toRelativePath(options.config.rootDir, options.targetOwner.packageJsonPath)}`,
    ...(options.workspacePackage?.name
      ? [`  workspace package: ${options.workspacePackage.name}`]
      : []),
    `  reason: ${reason}`,
  ];
  options.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourcePackageImportInvalid,
      facts: {
        importerPath: options.importRecord.filePath,
        kind: 'other-owner-target',
        line: options.importRecord.line,
        packageManifestPath: options.owner.packageJsonPath,
        packageName: options.owner.name ?? undefined,
        resolvedTargetPath: options.resolvedFilePath,
        specifier: options.importRecord.specifier,
        targetPackageManifestPath: options.targetOwner.packageJsonPath,
        targetPackageName:
          options.targetOwner.name ??
          options.workspacePackage?.name ??
          undefined,
      },
      filePath: options.importRecord.filePath,
      lines,
      ownerName: options.owner.name ?? undefined,
      packageJsonPath: options.owner.packageJsonPath,
      reason,
      title,
    }),
  );
}

function addPackageImportRelativeScopeProblem(options: {
  config: ResolvedLiminaConfig;
  findings: SourceFinding[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  packageScope: NearestPackageInfo;
  resolvedFilePath: string;
  targetPackageScope: NearestPackageInfo | null;
}): void {
  const title = 'Package import relative target escapes package scope';
  const reason =
    '#... package imports with relative targets must stay inside the declaring package scope.';
  const lines = [
    `${title}:`,
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
    `  reason: ${reason}`,
  ];
  options.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourcePackageImportInvalid,
      facts: {
        importerPath: options.importRecord.filePath,
        kind: 'target-escapes-package-scope',
        line: options.importRecord.line,
        packageManifestPath: options.owner.packageJsonPath,
        packageName: options.owner.name ?? undefined,
        resolvedTargetPath: options.resolvedFilePath,
        specifier: options.importRecord.specifier,
        targetPackageManifestPath:
          options.targetPackageScope?.packageJsonPath ?? undefined,
        targetPackageName: options.targetPackageScope?.name ?? undefined,
      },
      filePath: options.importRecord.filePath,
      lines,
      ownerName: options.owner.name ?? undefined,
      packageJsonPath: options.owner.packageJsonPath,
      reason,
      title,
    }),
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
  findings: SourceFinding[];
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  packages: WorkspacePackage[];
  packageInfo: NearestPackageInfo;
  rootPackage: WorkspacePackage | null;
  workspacePackage: WorkspacePackage | null;
}): void {
  if (!options.packageInfo.name) {
    addResolvedPackageWithoutNameProblem({
      config: options.config,
      findings: options.findings,
      importRecord: options.importRecord,
      owner: options.owner,
      packageInfo: options.packageInfo,
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
    findings: options.findings,
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
  findings: SourceFinding[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  packages: WorkspacePackage[];
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
    const title = 'Unauthorized package import specifier';
    const reason =
      '#... package imports must match the nearest package scope package.json imports field.';
    const lines = [
      `${title}:`,
      `  source owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
      ...(packageScope
        ? [
            `  package scope: ${toRelativePath(options.config.rootDir, packageScope.packageJsonPath)}`,
          ]
        : []),
      `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
      `  imported specifier: ${options.importRecord.specifier}`,
      `  reason: ${reason}`,
    ];
    options.findings.push(
      createSourceDiagnosticFinding({
        code: LIMINA_CHECK_ISSUE_CODES.sourcePackageImportInvalid,
        facts: {
          importerPath: options.importRecord.filePath,
          kind: 'specifier-unauthorized',
          line: options.importRecord.line,
          packageManifestPath: options.owner.packageJsonPath,
          packageName: options.owner.name ?? undefined,
          specifier: options.importRecord.specifier,
        },
        filePath: options.importRecord.filePath,
        lines,
        ownerName: options.owner.name ?? undefined,
        packageJsonPath: options.owner.packageJsonPath,
        reason,
        title,
      }),
    );
    return;
  }

  if (!options.resolvedFilePath) {
    const title = 'Unresolved package import specifier';
    const reason =
      'matched #... package imports must resolve from the nearest package scope package.json imports field.';
    const lines = [
      `${title}:`,
      `  source owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
      ...(packageScope
        ? [
            `  package scope: ${toRelativePath(options.config.rootDir, packageScope.packageJsonPath)}`,
          ]
        : []),
      `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
      `  imported specifier: ${options.importRecord.specifier}`,
      `  reason: ${reason}`,
    ];
    options.findings.push(
      createSourceDiagnosticFinding({
        code: LIMINA_CHECK_ISSUE_CODES.sourcePackageImportInvalid,
        facts: {
          importerPath: options.importRecord.filePath,
          kind: 'specifier-unresolved',
          line: options.importRecord.line,
          packageManifestPath: options.owner.packageJsonPath,
          packageName: options.owner.name ?? undefined,
          specifier: options.importRecord.specifier,
        },
        filePath: options.importRecord.filePath,
        lines,
        ownerName: options.owner.name ?? undefined,
        packageJsonPath: options.owner.packageJsonPath,
        reason,
        title,
      }),
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
      findings: options.findings,
      importRecord: options.importRecord,
      owner: options.owner,
      packageScope,
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
        findings: options.findings,
        importRecord: options.importRecord,
        owner: options.owner,
        packageScope,
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
        findings: options.findings,
        importAuthorityAllowRules: options.importAuthorityAllowRules,
        importRecord: options.importRecord,
        owner: options.owner,
        packages: options.packages,
        packageInfo: target.packageInfo,
        rootPackage: options.rootPackage,
        workspacePackage: target.workspacePackage,
      });
      return;
    }

    addPackageImportOtherOwnerProblem({
      config: options.config,
      findings: options.findings,
      importRecord: options.importRecord,
      owner: options.owner,
      resolvedFilePath: options.resolvedFilePath,
      targetOwner: target.targetOwner,
      workspacePackage: target.workspacePackage,
    });
    return;
  }

  if (target.kind === 'artifact-package') {
    addPackageImportArtifactAuthorizationProblem({
      config: options.config,
      findings: options.findings,
      importAuthorityAllowRules: options.importAuthorityAllowRules,
      importRecord: options.importRecord,
      owner: options.owner,
      packages: options.packages,
      packageInfo: target.packageInfo,
      rootPackage: options.rootPackage,
      workspacePackage: null,
    });
    return;
  }

  const title = 'Package import resolves outside source ownership';
  const reason =
    '#... package imports must resolve to the current source owner or to a named artifact package dependency.';
  const lines = [
    `${title}:`,
    `  source owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
    `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  resolved file: ${toRelativePath(options.config.rootDir, options.resolvedFilePath)}`,
    `  reason: ${reason}`,
  ];
  options.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourcePackageImportInvalid,
      facts: {
        importerPath: options.importRecord.filePath,
        kind: 'outside-source-ownership',
        line: options.importRecord.line,
        packageManifestPath: options.owner.packageJsonPath,
        packageName: options.owner.name ?? undefined,
        resolvedTargetPath: options.resolvedFilePath,
        specifier: options.importRecord.specifier,
      },
      filePath: options.importRecord.filePath,
      lines,
      ownerName: options.owner.name ?? undefined,
      packageJsonPath: options.owner.packageJsonPath,
      reason,
      title,
    }),
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
  findings: SourceFinding[];
  matchedOwnerConfigPaths: string[];
  reason: string;
  searchedTsconfigPaths: string[];
  status: 'missing' | 'multiple' | 'unmatched';
  tsconfigPath: string | null;
}): void {
  const title = 'Tsconfig search cannot determine module owner';
  const fix =
    'make one tsconfig.json between the module directory and its activated package-island root include the module, or make its ordinary typecheck references reach exactly one owner tsconfig.';
  const lines = [
    `${title}:`,
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
    `  fix: ${fix}`,
  ];
  options.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance,
      facts: {
        candidateConfigPaths: options.searchedTsconfigPaths,
        filePath: options.fileName,
        kind: 'module-owner-unresolved',
        matchedConfigPaths: options.matchedOwnerConfigPaths,
        resolverConfigPath: options.tsconfigPath ?? undefined,
        status: options.status,
      },
      filePath: options.fileName,
      fix,
      lines,
      reason: options.reason,
      title,
    }),
  );
}

async function addTsconfigGovernanceProblems(options: {
  ambientDeclarations: AmbientDeclarationIndex;
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  configPaths: string[];
  findings: SourceFinding[];
  generatedGraph: GeneratedTsconfigGraphResult;
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
      const title = 'Tsconfig has no source owner';
      const reason =
        'every tsconfig*.json that governs modules must be assigned to its pnpm workspace source owner.';
      const lines = [
        `${title}:`,
        `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
        `  reason: ${reason}`,
      ];
      options.findings.push(
        createSourceDiagnosticFinding({
          code: LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance,
          facts: {
            configPath,
            kind: 'config-missing-owner',
          },
          filePath: configPath,
          lines,
          reason,
          title,
        }),
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
        const title = 'Tsconfig source file set crosses source owner scope';
        const reason =
          'every source-owner tsconfig*.json must govern only modules owned by the same pnpm workspace source owner.';
        const lines = [
          `${title}:`,
          `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
          `  source owner: ${toRelativePath(options.config.rootDir, owner.packageJsonPath)}`,
          `  file: ${toRelativePath(options.config.rootDir, fileName)}`,
          ...(fileOwner
            ? [
                `  file source owner: ${toRelativePath(options.config.rootDir, fileOwner.packageJsonPath)}`,
              ]
            : []),
          `  reason: ${reason}`,
        ];
        options.findings.push(
          createSourceDiagnosticFinding({
            code: LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance,
            facts: {
              configPath,
              filePaths: [fileName],
              kind: 'config-owner-scope',
              packageManifestPaths: [
                owner.packageJsonPath,
                ...(fileOwner ? [fileOwner.packageJsonPath] : []),
              ],
            },
            filePath: fileName,
            lines,
            ownerName: owner.name ?? undefined,
            packageJsonPath: owner.packageJsonPath,
            reason,
            title,
          }),
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

    const title =
      'Ambient declaration is shared across source owners without authorization';
    const reason =
      'more than one distinct source owner consumes this ambient declaration, but allowSharedAcrossOwners is false.';
    const fix =
      'set allowSharedAcrossOwners: true or narrow the ambient include and consuming tsconfig file sets.';
    const sortedConsumers = [...consumers.values()].sort((left, right) =>
      left.owner.packageJsonPath.localeCompare(right.owner.packageJsonPath),
    );
    const ruleIdentity = `source.declarations.ambient[${policy.ruleIndex}]`;
    const lines = [
      `${title}:`,
      `  file: ${toRelativePath(options.config.rootDir, fileName)}`,
      `  rule: ${ruleIdentity}`,
      '  source owners:',
      ...sortedConsumers.flatMap((consumer) => [
        `    - ${toRelativePath(options.config.rootDir, consumer.owner.packageJsonPath)}`,
        ...consumer.configPaths
          .sort((left, right) => left.localeCompare(right))
          .map(
            (consumerConfigPath) =>
              `      config: ${toRelativePath(options.config.rootDir, consumerConfigPath)}`,
          ),
      ]),
      `  configured reason: ${policy.reason}`,
      `  reason: ${reason}`,
      `  fix: ${fix}`,
    ];
    options.findings.push(
      createSourceDiagnosticFinding({
        code: LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationSharedUnauthorized,
        facts: {
          consumers: sortedConsumers.map((consumer) => ({
            configPaths: consumer.configPaths,
            packageManifestPath: consumer.owner.packageJsonPath,
            packageName: consumer.owner.name ?? undefined,
          })),
          declarationPath: fileName,
          kind: 'shared-across-owners',
          ruleIdentity,
          ruleIndex: policy.ruleIndex,
        },
        filePath: fileName,
        fix,
        lines,
        reason,
        scope: ruleIdentity,
        title,
      }),
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
        findings: options.findings,
        matchedOwnerConfigPaths: ownershipResolution.matchedOwnerConfigPaths,
        reason:
          'no tsconfig.json was found between the module directory and its activated package-island root.',
        searchedTsconfigPaths: ownershipResolution.searchedTsconfigPaths,
        status: 'missing',
        tsconfigPath: ownershipResolution.tsconfigPath,
      });
    } else if (ownershipResolution.status !== 'matched') {
      addNearestTsconfigOwnershipProblem({
        config: options.config,
        fileName,
        findings: options.findings,
        matchedOwnerConfigPaths: ownershipResolution.matchedOwnerConfigPaths,
        reason:
          ownershipResolution.status === 'unmatched'
            ? 'no tsconfig.json between the module directory and its activated package-island root includes the module or reaches one ordinary typecheck config that includes it.'
            : 'the first matching tsconfig.json reaches multiple ordinary typecheck configs that include the module.',
        searchedTsconfigPaths: ownershipResolution.searchedTsconfigPaths,
        status: ownershipResolution.status,
        tsconfigPath: ownershipResolution.tsconfigPath,
      });
    }

    if (governanceUnits.size <= 1) {
      continue;
    }

    const uniqueOwners = uniqueValues(
      [...governanceUnits.values()].map((unit) => unit.owner.packageJsonPath),
    );

    const configPaths = [...governanceUnits.values()]
      .flatMap((unit) => unit.configPaths)
      .sort((left, right) =>
        toRelativePath(options.config.rootDir, left).localeCompare(
          toRelativePath(options.config.rootDir, right),
        ),
      );
    const governanceTitle =
      'Source module belongs to multiple tsconfig governance units';
    const governanceReason =
      'a module may belong to only one ordinary typecheck tsconfig*.json governance unit.';
    const governanceLines = [
      `${governanceTitle}:`,
      `  file: ${toRelativePath(options.config.rootDir, fileName)}`,
      '  configs:',
      ...configPaths.map(
        (configPath) =>
          `    - ${toRelativePath(options.config.rootDir, configPath)}`,
      ),
      `  reason: ${governanceReason}`,
    ];
    options.findings.push(
      createSourceDiagnosticFinding({
        code: LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance,
        facts: {
          configPaths,
          filePath: fileName,
          kind: 'multiple-governance-units',
        },
        filePath: fileName,
        lines: governanceLines,
        reason: governanceReason,
        title: governanceTitle,
      }),
    );

    if (uniqueOwners.length <= 1) {
      continue;
    }

    const ownerTitle = 'Source module belongs to multiple source owners';
    const ownerReason =
      'source ownership prohibits overlap between module sets governed by different pnpm workspace source owners.';
    const sortedOwners = uniqueOwners.sort((left, right) =>
      toRelativePath(options.config.rootDir, left).localeCompare(
        toRelativePath(options.config.rootDir, right),
      ),
    );
    const ownerLines = [
      `${ownerTitle}:`,
      `  file: ${toRelativePath(options.config.rootDir, fileName)}`,
      '  source owners:',
      ...sortedOwners.map(
        (packageJsonPath) =>
          `    - ${toRelativePath(options.config.rootDir, packageJsonPath)}`,
      ),
      `  reason: ${ownerReason}`,
    ];
    options.findings.push(
      createSourceDiagnosticFinding({
        code: LIMINA_CHECK_ISSUE_CODES.sourceOwnerInvalid,
        facts: {
          filePath: fileName,
          kind: 'multiple-owners',
          packageManifestPaths: sortedOwners,
        },
        filePath: fileName,
        lines: ownerLines,
        reason: ownerReason,
        title: ownerTitle,
      }),
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
  const unusedDependencyCodesByIssueKey = new Map(
    options.knipIssues.unusedWorkspaceDependencies.map((issue) => [
      createPackageDependencyIssueKey(
        issue.packageJsonPath,
        issue.dependencyName,
      ),
      issue.externalCode,
    ]),
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

    const externalCode = unusedDependencyCodesByIssueKey.get(
      createPackageDependencyIssueKey(
        declaration.packageJsonPath,
        declaration.dependencyName,
      ),
    );

    if (!externalCode) {
      continue;
    }

    options.issues.push(
      createSourceUnusedWorkspaceDependencyFinding({
        dependencyName: declaration.dependencyName,
        externalCode,
        ownerName: declaration.importer.name,
        packageJsonPath: declaration.packageJsonPath,
        sectionName: declaration.sectionName,
        specifier: declaration.specifier,
      }),
    );
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

    options.issues.push(
      createSourceUnusedModuleFinding({
        externalCode: issue.externalCode,
        filePath,
        ownerDirectory: moduleSet.owner.directory,
        ownerName: moduleSet.owner.name,
        packageJsonPath: moduleSet.owner.packageJsonPath,
      }),
    );
  }
}

async function addKnipBackedSourceProblems(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  generatedGraph: GeneratedTsconfigGraphResult;
  findings: SourceFinding[];
  knipRunner?: KnipCliRunner;
  ownerModuleSets: OwnerSourceModuleSet[];
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
    findings: options.findings,
    workspacePackages: options.workspacePackages,
  });

  for (const diagnostic of options.generatedGraph.generatedKnipDiagnostics) {
    options.checks.add();
    const title =
      'Unsupported package build script for generated Knip tsconfig';
    const lines = [
      `${title}:`,
      `  package: ${diagnostic.packageName ?? '<unnamed>'}`,
      `  package manifest: ${toRelativePath(options.config.rootDir, diagnostic.packageJsonPath)}`,
      ...(diagnostic.scriptName ? [`  script: ${diagnostic.scriptName}`] : []),
      ...(diagnostic.command ? [`  command: ${diagnostic.command}`] : []),
      `  reason: ${diagnostic.reason}`,
    ];
    options.findings.push(
      createSourceDiagnosticFinding({
        code: LIMINA_CHECK_ISSUE_CODES.sourceKnipBuildScriptUnsupported,
        external: { tool: 'knip' },
        facts: {
          command: diagnostic.command,
          kind: 'unsupported-build-script',
          packageManifestPath: diagnostic.packageJsonPath,
          packageName: diagnostic.packageName ?? undefined,
          scriptName: diagnostic.scriptName,
        },
        lines,
        ownerName: diagnostic.packageName ?? '<unnamed>',
        packageJsonPath: diagnostic.packageJsonPath,
        reason: diagnostic.reason,
        title,
        tool: 'knip',
      }),
    );
  }

  const ignoredDependencies = collectUnusedDependencyIgnore({
    declarations,
    findings: options.findings,
    knipWorkspaceConfigs,
    workspacePackages: options.workspacePackages,
  });
  const unusedModuleConfig = collectUnusedModuleConfig({
    config: options.config,
    findings: options.findings,
    knipWorkspaceConfigs,
    ownerModuleSets: options.ownerModuleSets,
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

  if (options.findings.length > 0) {
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
  projectCheckerNamesByPath: ReadonlyMap<string, readonly string[]>,
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
          checkerNames: [
            ...(projectCheckerNamesByPath.get(project.configPath) ?? []),
          ],
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

function createGeneratedProjectCheckerNamesByPath(
  generatedGraph: GeneratedTsconfigGraphResult,
): Map<string, string[]> {
  const checkerNamesByPath = new Map<string, string[]>();

  for (const [checkerName, sourceToDts] of generatedGraph.sourceToDts) {
    for (const [sourceConfigPath, dtsConfigPath] of sourceToDts) {
      for (const configPath of [sourceConfigPath, dtsConfigPath]) {
        checkerNamesByPath.set(
          configPath,
          uniqueSortedStrings([
            ...(checkerNamesByPath.get(configPath) ?? []),
            checkerName,
          ]),
        );
      }
    }
  }

  return checkerNamesByPath;
}

async function addSourceProjectOwnerProblems(options: {
  ambientDeclarations: AmbientDeclarationIndex;
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  findings: SourceFinding[];
  providers: AnalysisProviderSet;
  projects: ProjectInfo[];
  workspaceLookup: WorkspaceLookupIndex;
}): Promise<void> {
  for (const project of options.projects) {
    if (project.labelDiagnostic) {
      options.findings.push(
        createSourceDiagnosticFinding({
          code: LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance,
          facts: {
            configPath: project.labelDiagnostic.projectPath,
            field: project.labelDiagnostic.field,
            kind: 'project-label',
            value: project.labelDiagnostic.value,
          },
          filePath: project.labelDiagnostic.projectPath,
          lines: project.labelDiagnostic.detailLines,
          locations: [
            {
              filePath: project.labelDiagnostic.projectPath,
              label: 'project',
            },
            { label: 'field', scope: project.labelDiagnostic.field },
          ],
          reason: project.labelDiagnostic.reason,
          scope: project.labelDiagnostic.field,
          title: project.labelDiagnostic.title,
        }),
      );
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
      findings: options.findings,
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
      findings: options.findings,
      role: 'typecheck companion',
      workspaceLookup: options.workspaceLookup,
    });
  }
}

function addRelativeImportProblems(options: {
  ambientDeclarations: AmbientDeclarationIndex;
  config: ResolvedLiminaConfig;
  filePath: string;
  findings: SourceFinding[];
  importRecord: ImportRecord;
  owner: PackageOwner;
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
      const title =
        'Ambient declaration triple-slash path reference is not authorized';
      const reason =
        'allowTripleSlashReferences is false for the matched ambient declaration rule.';
      const fix =
        'set allowTripleSlashReferences: true or remove the triple-slash path reference.';
      const ruleIdentity = `source.declarations.ambient[${policy.ruleIndex}]`;
      const lines = [
        `${title}:`,
        `  source owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
        `  file: ${toRelativePath(options.config.rootDir, options.filePath)}:${options.importRecord.line}`,
        `  declaration target: ${toRelativePath(options.config.rootDir, options.resolvedFilePath)}`,
        `  rule: ${ruleIdentity}`,
        `  reason: ${reason}`,
        `  fix: ${fix}`,
      ];
      options.findings.push(
        createSourceDiagnosticFinding({
          code: LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationReferenceUnauthorized,
          facts: {
            declarationPath: options.resolvedFilePath,
            importerPath: options.filePath,
            kind: 'triple-slash-path-reference',
            line: options.importRecord.line,
            packageManifestPath: options.owner.packageJsonPath,
            packageName: options.owner.name ?? undefined,
            referenceKind: options.importRecord.kind,
            ruleIdentity,
            ruleIndex: policy.ruleIndex,
          },
          filePath: options.filePath,
          fix,
          lines,
          ownerName: options.owner.name ?? undefined,
          packageJsonPath: options.owner.packageJsonPath,
          reason,
          scope: ruleIdentity,
          title,
        }),
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
    findings: options.findings,
    importRecord: options.importRecord,
    owner: options.owner,
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
  findings: SourceFinding[];
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
      findings: options.findings,
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
    findings: options.findings,
    workspacePackage: options.target.workspacePackage,
  });
}

function addResolvedArtifactBarePackageProblems(options: {
  config: ResolvedLiminaConfig;
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  packages: WorkspacePackage[];
  findings: SourceFinding[];
  rootPackage: WorkspacePackage | null;
  target: Extract<ResolvedPackageTarget, { kind: 'artifact-package' }>;
}): void {
  if (!options.target.packageInfo.name) {
    addResolvedPackageWithoutNameProblem({
      config: options.config,
      importRecord: options.importRecord,
      owner: options.owner,
      packageInfo: options.target.packageInfo,
      findings: options.findings,
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
    findings: options.findings,
    workspacePackage: null,
  });
}

function addResolvedBarePackageImportProblems(options: {
  config: ResolvedLiminaConfig;
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  packages: WorkspacePackage[];
  findings: SourceFinding[];
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
      findings: options.findings,
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
      findings: options.findings,
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
  findings: SourceFinding[];
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
      findings: options.findings,
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
    findings: options.findings,
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
  findings: SourceFinding[];
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
      findings: options.findings,
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
      findings: options.findings,
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
      findings: options.findings,
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
      findings: options.findings,
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
    findings: options.findings,
    resolvedFilePath,
    rootPackage: options.rootPackage,
    workspaceLookup: options.workspaceLookup,
  });
}

function addResourceModuleProblems(options: {
  checkerName: string;
  config: ResolvedLiminaConfig;
  findings: SourceFinding[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  project: ProjectInfo;
  typeEvidence: AnalysisProviderSet['typeEvidence'];
}): void {
  const runtimeEvidence = options.typeEvidence.classifyImportRuntime({
    checkerName: options.checkerName,
    importRecord: options.importRecord,
    project: options.project,
  });

  if (runtimeEvidence.classification !== 'resource') {
    return;
  }

  if (
    options.importRecord.kind === 'require-resolve' &&
    runtimeEvidence.runtime.kind !== 'missing'
  ) {
    return;
  }

  const evidence = options.typeEvidence.resolveImportEvidence({
    checkerName: options.checkerName,
    importRecord: options.importRecord,
    project: options.project,
  });

  if (evidence.runtime.kind === 'missing') {
    const title = 'Resource module was not found';
    const checkedPath = evidence.runtime.checkedPath;

    options.findings.push(
      createSourceDiagnosticFinding({
        checkerName: options.checkerName,
        code: LIMINA_CHECK_ISSUE_CODES.sourceResourceModuleNotFound,
        facts: {
          checkedPath,
          checkerName: options.checkerName,
          configPath: options.project.configPath,
          importerPath: options.importRecord.filePath,
          kind: 'resource-module-not-found',
          line: options.importRecord.line,
          specifier: options.importRecord.specifier,
          typeEvidenceKind: evidence.type.kind,
        },
        filePath: options.importRecord.filePath,
        fix: 'Create the referenced resource at the resolved path or correct the import specifier.',
        lines: [
          `${title}:`,
          `  import: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
          `  specifier: ${options.importRecord.specifier}`,
          `  checker: ${options.checkerName}`,
          ...(checkedPath
            ? [
                `  checked path: ${toRelativePath(options.config.rootDir, checkedPath)}`,
              ]
            : []),
          `  type evidence: ${evidence.type.kind}`,
        ],
        locations: [
          {
            filePath: options.importRecord.filePath,
            label: 'import',
            line: options.importRecord.line,
          },
        ],
        ownerName: options.owner.name,
        packageJsonPath: options.owner.packageJsonPath,
        reason:
          'Ambient or concrete type evidence cannot establish that a physical resource exists at runtime.',
        title,
      }),
    );
    return;
  }

  if (evidence.runtime.kind !== 'file' || evidence.type.kind !== 'missing') {
    return;
  }

  const title = 'Resource module type is undeclared';
  options.findings.push(
    createSourceDiagnosticFinding({
      checkerName: options.checkerName,
      code: LIMINA_CHECK_ISSUE_CODES.sourceResourceModuleTypeUndeclared,
      facts: {
        checkerName: options.checkerName,
        configPath: options.project.configPath,
        importerPath: options.importRecord.filePath,
        kind: 'resource-module-type-undeclared',
        line: options.importRecord.line,
        runtimeAuthority: evidence.runtime.authority,
        runtimeFilePath: evidence.runtime.filePath,
        specifier: options.importRecord.specifier,
        typeEvidenceKind: evidence.type.kind,
      },
      filePath: options.importRecord.filePath,
      fix: 'Add a concrete declaration companion or an ambient module declaration included by this checker project.',
      lines: [
        `${title}:`,
        `  import: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
        `  specifier: ${options.importRecord.specifier}`,
        `  checker: ${options.checkerName}`,
        `  runtime file: ${toRelativePath(options.config.rootDir, evidence.runtime.filePath)}`,
      ],
      locations: [
        {
          filePath: options.importRecord.filePath,
          label: 'import',
          line: options.importRecord.line,
        },
        {
          filePath: evidence.runtime.filePath,
          label: 'resource',
        },
      ],
      ownerName: options.owner.name,
      packageJsonPath: options.owner.packageJsonPath,
      reason:
        'The resource exists, but the current checker project has no concrete or ambient declaration for the import.',
      title,
    }),
  );
}

function addSourceImportProblems(options: {
  ambientDeclarations: AmbientDeclarationIndex;
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  importAnalysis: AnalysisProviderSet['imports']['context'];
  importAuthorityAllowRules: CompiledImportAuthorityAllowRule[];
  packages: WorkspacePackage[];
  pathIndex: WorkspaceRegionPathIndex;
  findings: SourceFinding[];
  rootPackage: WorkspacePackage | null;
  sourceProjectEntries: SourceProjectEntry[];
  typeEvidence: AnalysisProviderSet['typeEvidence'];
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  for (const {
    checkerNames,
    fileNames,
    project,
  } of options.sourceProjectEntries) {
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
        for (const checkerName of checkerNames) {
          addResourceModuleProblems({
            checkerName,
            config: options.config,
            findings: options.findings,
            importRecord,
            owner,
            project,
            typeEvidence: options.typeEvidence,
          });
        }
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
          findings: options.findings,
          project,
          rootPackage: options.rootPackage,
          workspaceLookup: options.workspaceLookup,
        });
      }
    }

    options.typeEvidence.completeProject(project.configPath);
  }
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
  const findings: SourceFinding[] = [];
  const sourceIssues: SourceCheckIssue[] = [];
  const checks = createCheckCounter();
  const checkItems = createCheckItemAccumulator(
    () => findings.length + sourceIssues.length,
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
    createGeneratedProjectCheckerNamesByPath(generatedGraph),
    projects,
    workspaceLookup,
  );
  const packages = await preflight.ensureWorkspacePackages();
  const workspaceContext = await preflight.ensureWorkspaceValidated();
  const workspacePathIndex = await preflight.ensureWorkspacePathIndex();
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
  findings.push(
    ...graphRoute.diagnostics.map((diagnostic) =>
      createSourceDiagnosticFinding({
        checkerName: diagnostic.checkerName,
        code: LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance,
        facts: {
          checkerName: diagnostic.checkerName,
          configPath: diagnostic.filePath,
          kind: 'checker-route',
        },
        filePath: diagnostic.filePath,
        lines: diagnostic.detailLines,
        reason: diagnostic.reason,
        title: diagnostic.title,
      }),
    ),
  );
  checks.add(projectPaths.length);
  checkItems.record('source graph routes');

  checkItems.start('tsconfig governance');
  await addTsconfigGovernanceProblems({
    ambientDeclarations: ambientDeclarationResult.index,
    checks,
    config,
    configPaths: collectGeneratedSourceConfigPaths(generatedGraph),
    findings,
    generatedGraph,
    workspaceLookup,
  });
  checkItems.record('tsconfig governance');

  checkItems.start('knip source usage');
  try {
    await addKnipBackedSourceProblems({
      checks,
      config,
      findings,
      generatedGraph,
      knipRunner: options.knipRunner,
      ownerModuleSets,
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
    findings,
    providers: core,
    projects,
    workspaceLookup,
  });
  checkItems.record('source project ownership');

  checkItems.start('source import authority');
  const importAuthorityAllowRules = collectImportAuthorityAllowRules({
    checks,
    config,
    findings,
  });
  addImportAuthorityOwnerConfigProblems({
    checks,
    config,
    findings,
    ownerIdentities: new Set(
      packageOwners.map((owner) =>
        getSourceOwnerIdentity({
          config,
          owner,
        }),
      ),
    ),
  });
  addImportAuthorityRootManifestConfigProblems({
    checks,
    config,
    findings,
    importAuthorityAllowRules,
  });

  addSourceImportProblems({
    ambientDeclarations: ambientDeclarationResult.index,
    checks,
    config,
    importAnalysis,
    importAuthorityAllowRules,
    packages,
    pathIndex: workspacePathIndex,
    findings,
    rootPackage,
    sourceProjectEntries,
    typeEvidence: core.typeEvidence,
    workspaceLookup,
  });
  checkItems.record('source import authority');

  const structuredSourceIssues = [...sourceIssues, ...findings];

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
        color: shouldUseColor(),
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
