import type {
  CheckerProjectConfigCache,
  CheckerProjectParseContext,
} from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import { parseProject } from '#core/import-graph/context';
import { compareCodeUnits, uniqueValues } from '#utils/collections';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { CheckCounter } from '../check-reporting/stats';
import { createSourceDiagnosticFinding } from './finding-utils';
import type { SourceFinding } from './findings';
import type {
  GovernanceUnit,
  GovernanceUnitsByFile,
} from './tsconfig-governance-types';
import { addNearestTsconfigOwnershipProblem } from './tsconfig-ownership-finding';
import { resolveTsconfigOwnership } from './tsconfig-ownership-resolution';

function createProjectFileSetReader(options: {
  cache: Map<string, Set<string>>;
  config: ResolvedLiminaConfig;
  context: CheckerProjectParseContext;
  projectConfigCache?: CheckerProjectConfigCache;
}): (configPath: string) => Set<string> {
  return (configPath) => {
    const normalizedPath = normalizeAbsolutePath(configPath);
    const cached = options.cache.get(normalizedPath);
    if (cached) {
      return cached;
    }

    const fileSet = new Set(
      parseProject(
        options.config,
        normalizedPath,
        options.context,
        undefined,
        options.projectConfigCache,
      ).fileNames,
    );
    options.cache.set(normalizedPath, fileSet);
    return fileSet;
  };
}

function getOwnershipFailureReason(
  status: 'missing' | 'multiple' | 'unmatched',
): string {
  const reasons = {
    missing:
      'no tsconfig.json was found between the module directory and its activated package-island root.',
    multiple:
      'the first matching tsconfig.json reaches multiple ordinary typecheck configs that include the module.',
    unmatched:
      'no tsconfig.json between the module directory and its activated package-island root includes the module or reaches one ordinary typecheck config that includes it.',
  } as const;

  return reasons[status];
}

function addOwnershipResolutionFinding(options: {
  config: ResolvedLiminaConfig;
  fileName: string;
  findings: SourceFinding[];
  getProjectFileSet: (configPath: string) => Set<string>;
  units: Map<string, GovernanceUnit>;
}): void {
  const ownerRootDir = [...options.units.values()][0]!.owner.directory;
  const resolution = resolveTsconfigOwnership({
    config: options.config,
    fileName: options.fileName,
    getProjectFileSet: options.getProjectFileSet,
    ownerRootDir,
  });
  if (resolution.status === 'matched') {
    return;
  }

  addNearestTsconfigOwnershipProblem({
    config: options.config,
    fileName: options.fileName,
    findings: options.findings,
    matchedOwnerConfigPaths: resolution.matchedOwnerConfigPaths,
    reason: getOwnershipFailureReason(resolution.status),
    searchedTsconfigPaths: resolution.searchedTsconfigPaths,
    status: resolution.status,
    tsconfigPath: resolution.tsconfigPath,
  });
}

function collectConfigPaths(
  config: ResolvedLiminaConfig,
  units: Map<string, GovernanceUnit>,
): string[] {
  return [...units.values()]
    .flatMap((unit) => unit.configPaths)
    .sort((left, right) =>
      compareCodeUnits(
        toRelativePath(config.rootDir, left),
        toRelativePath(config.rootDir, right),
      ),
    );
}

function addGovernanceUnitFinding(options: {
  config: ResolvedLiminaConfig;
  fileName: string;
  findings: SourceFinding[];
  units: Map<string, GovernanceUnit>;
}): void {
  if (options.units.size <= 1) {
    return;
  }

  const configPaths = collectConfigPaths(options.config, options.units);
  const title = 'Source module belongs to multiple tsconfig governance units';
  const reason =
    'a module may belong to only one ordinary typecheck tsconfig*.json governance unit.';
  const lines = [
    `${title}:`,
    `  file: ${toRelativePath(options.config.rootDir, options.fileName)}`,
    '  configs:',
    ...configPaths.map(
      (configPath) =>
        `    - ${toRelativePath(options.config.rootDir, configPath)}`,
    ),
    `  reason: ${reason}`,
  ];

  options.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance,
      facts: {
        configPaths,
        filePath: options.fileName,
        kind: 'multiple-governance-units',
      },
      filePath: options.fileName,
      lines,
      reason,
      title,
    }),
  );
}

function collectUniqueOwners(units: Map<string, GovernanceUnit>): string[] {
  return uniqueValues(
    [...units.values()].map((unit) => unit.owner.packageJsonPath),
  );
}

function addMultipleOwnerFinding(options: {
  config: ResolvedLiminaConfig;
  fileName: string;
  findings: SourceFinding[];
  units: Map<string, GovernanceUnit>;
}): void {
  const uniqueOwners = collectUniqueOwners(options.units);
  if (uniqueOwners.length <= 1) {
    return;
  }

  const sortedOwners = uniqueOwners.sort((left, right) =>
    compareCodeUnits(
      toRelativePath(options.config.rootDir, left),
      toRelativePath(options.config.rootDir, right),
    ),
  );
  const title = 'Source module belongs to multiple source owners';
  const reason =
    'source ownership prohibits overlap between module sets governed by different pnpm workspace source owners.';
  const lines = [
    `${title}:`,
    `  file: ${toRelativePath(options.config.rootDir, options.fileName)}`,
    '  source owners:',
    ...sortedOwners.map(
      (packageJsonPath) =>
        `    - ${toRelativePath(options.config.rootDir, packageJsonPath)}`,
    ),
    `  reason: ${reason}`,
  ];

  options.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourceOwnerInvalid,
      facts: {
        filePath: options.fileName,
        kind: 'multiple-owners',
        packageManifestPaths: sortedOwners,
      },
      filePath: options.fileName,
      lines,
      reason,
      title,
    }),
  );
}

function addFileGovernanceFindings(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  fileName: string;
  findings: SourceFinding[];
  getProjectFileSet: (configPath: string) => Set<string>;
  units: Map<string, GovernanceUnit>;
}): void {
  options.checks.add();
  addOwnershipResolutionFinding(options);
  addGovernanceUnitFinding(options);
  addMultipleOwnerFinding(options);
}

export function addGovernanceOverlapFindings(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  context: CheckerProjectParseContext;
  findings: SourceFinding[];
  governanceUnitsByFile: GovernanceUnitsByFile;
  projectFileSetsByConfigPath: Map<string, Set<string>>;
  projectConfigCache?: CheckerProjectConfigCache;
}): void {
  const getProjectFileSet = createProjectFileSetReader({
    cache: options.projectFileSetsByConfigPath,
    config: options.config,
    context: options.context,
    projectConfigCache: options.projectConfigCache,
  });
  const entries = [...options.governanceUnitsByFile.entries()].sort(
    ([left], [right]) =>
      compareCodeUnits(
        toRelativePath(options.config.rootDir, left),
        toRelativePath(options.config.rootDir, right),
      ),
  );

  for (const [fileName, units] of entries) {
    addFileGovernanceFindings({
      checks: options.checks,
      config: options.config,
      fileName,
      findings: options.findings,
      getProjectFileSet,
      units,
    });
  }
}
