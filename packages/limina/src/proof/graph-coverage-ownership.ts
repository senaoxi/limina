import type { ResolvedLiminaConfig } from '#config/runner';
import {
  type CheckerGraphProjectRoute,
  isDtsConfigPath,
} from '#core/tsconfig/actions';
import { uniqueSortedStrings, uniqueValues } from '#utils/collections';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  toRelativePath,
} from '#utils/path';
import { existsSync } from 'node:fs';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import {
  createCheckerProjectContext,
  parseProjectCoverage,
} from './checker-context';
import {
  createProofDiagnosticFinding,
  getProofPackageIdentity,
} from './finding-utils';
import type { ProofFinding } from './findings';
import { isCheckerGraphDeclarationOwnerCandidate } from './ownership-candidates';
import type { ConfigFileOwner, ConfigFileOwners } from './runner-types';

interface OwnerEntry {
  filePath: string;
  owner: ConfigFileOwner;
}

function projectConfigExists(
  configPath: string,
  virtualFiles: ReadonlyMap<string, string>,
): boolean {
  return (
    existsSync(configPath) ||
    virtualFiles.has(normalizeAbsolutePath(configPath))
  );
}

function createProjectOwnerEntries(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  route: CheckerGraphProjectRoute;
  sourceFiles: Set<string>;
  virtualFiles: ReadonlyMap<string, string>;
}): OwnerEntry[] {
  if (!projectConfigExists(options.configPath, options.virtualFiles)) {
    return [];
  }

  const projectContext = createCheckerProjectContext({
    config: options.config,
    configPath: options.configPath,
    extensions: options.route.extensions,
    preset: options.route.checkerPreset,
    virtualFiles: options.virtualFiles,
  });
  const projectCoverage = parseProjectCoverage({
    config: options.config,
    configPath: options.configPath,
    context: projectContext,
    virtualFiles: options.virtualFiles,
  });
  const owner: ConfigFileOwner = {
    checkerEntryPath: options.route.rootConfigPath,
    checkerName: options.route.checkerName,
    checkerPreset: options.route.checkerPreset,
    configPath: options.configPath,
  };

  return projectCoverage.fileNames
    .filter((filePath) =>
      isPathInsideDirectory(filePath, projectCoverage.ownerRootDir),
    )
    .filter((filePath) => options.sourceFiles.has(filePath))
    .filter((filePath) =>
      isCheckerGraphDeclarationOwnerCandidate(
        filePath,
        projectContext.extensions,
      ),
    )
    .map((filePath) => ({ filePath, owner }));
}

function collectOwnerEntries(options: {
  config: ResolvedLiminaConfig;
  graphRoutes: CheckerGraphProjectRoute[];
  sourceFiles: Set<string>;
  virtualFiles: ReadonlyMap<string, string>;
}): OwnerEntry[] {
  return options.graphRoutes.flatMap((route) =>
    route.projectPaths.filter(isDtsConfigPath).flatMap((configPath) =>
      createProjectOwnerEntries({
        config: options.config,
        configPath,
        route,
        sourceFiles: options.sourceFiles,
        virtualFiles: options.virtualFiles,
      }),
    ),
  );
}

export function collectConfigFileOwners(options: {
  config: ResolvedLiminaConfig;
  graphRoutes: CheckerGraphProjectRoute[];
  sourceFiles: Set<string>;
  virtualFiles: ReadonlyMap<string, string>;
}): ConfigFileOwners {
  const ownersByFile: ConfigFileOwners = new Map();

  for (const entry of collectOwnerEntries(options)) {
    const owners = ownersByFile.get(entry.filePath) ?? [];

    owners.push(entry.owner);
    ownersByFile.set(entry.filePath, owners);
  }

  return ownersByFile;
}

function groupOwnersByPreset(
  owners: ConfigFileOwner[],
): Map<string, ConfigFileOwner[]> {
  const ownersByPreset = new Map<string, ConfigFileOwner[]>();

  for (const owner of owners) {
    const presetOwners = ownersByPreset.get(owner.checkerPreset) ?? [];

    presetOwners.push(owner);
    ownersByPreset.set(owner.checkerPreset, presetOwners);
  }

  return ownersByPreset;
}

function addDuplicateOwnerGroupFinding(options: {
  config: ResolvedLiminaConfig;
  filePath: string;
  findings: ProofFinding[];
  owners: ConfigFileOwner[];
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const uniqueOwners = uniqueValues(
    options.owners.map((owner) => owner.configPath),
  );

  if (uniqueOwners.length <= 1) {
    return;
  }

  const sortedOwners = uniqueOwners.sort((left, right) =>
    toRelativePath(options.config.rootDir, left).localeCompare(
      toRelativePath(options.config.rootDir, right),
    ),
  );
  const checkerNames = uniqueSortedStrings(
    options.owners.map((owner) => owner.checkerName),
  );
  const graphEntryPaths = uniqueSortedStrings(
    options.owners.map((owner) => owner.checkerEntryPath),
  );
  const reason =
    'a declaration-emitting source file must have a single generated dts owner; move the file to one dts leaf or narrow include/exclude patterns.';
  const detailLines = [
    'Duplicate checker graph coverage:',
    `  file: ${toRelativePath(options.config.rootDir, options.filePath)}`,
    '  covered by:',
    ...sortedOwners.map(
      (configPath) =>
        `    - ${toRelativePath(options.config.rootDir, configPath)}`,
    ),
    `  reason: ${reason}`,
  ];

  options.findings.push(
    createProofDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.proofDuplicateGraphCoverage,
      detailLines,
      evidence: [
        { label: 'diagnostic', lines: [...detailLines] },
        ...sortedOwners.map((projectPath) => ({
          label: 'declaration project',
          value: projectPath,
        })),
      ],
      facts: {
        checkerNames,
        checkerPreset: options.owners[0]!.checkerPreset,
        declarationProjectPaths: sortedOwners,
        graphEntryPaths,
        kind: 'multiple-declaration-projects',
        sourcePath: options.filePath,
      },
      filePath: options.filePath,
      locations: [
        { filePath: options.filePath, label: 'source' },
        ...sortedOwners.map((projectPath) => ({
          filePath: projectPath,
          label: 'declaration project',
        })),
      ],
      packageIdentity: getProofPackageIdentity(
        options.workspaceLookup,
        options.filePath,
      ),
      reason,
      title: 'Duplicate checker graph coverage',
    }),
  );
}

export function addDuplicateGraphCoverageFindings(options: {
  config: ResolvedLiminaConfig;
  findings: ProofFinding[];
  ownersByFile: ConfigFileOwners;
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const entries = [...options.ownersByFile].sort(([left], [right]) =>
    toRelativePath(options.config.rootDir, left).localeCompare(
      toRelativePath(options.config.rootDir, right),
    ),
  );

  for (const [filePath, owners] of entries) {
    for (const presetOwners of groupOwnersByPreset(owners).values()) {
      addDuplicateOwnerGroupFinding({
        config: options.config,
        filePath,
        findings: options.findings,
        owners: presetOwners,
        workspaceLookup: options.workspaceLookup,
      });
    }
  }
}
