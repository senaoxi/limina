import type { CheckerProjectConfigCache } from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import {
  compareCodeUnits,
  uniqueCodeUnitSortedStrings,
  uniqueValues,
} from '#utils/collections';
import { toRelativePath } from '#utils/path';
import path from 'pathe';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import { getActiveCheckerContext } from './checker-context';
import { parseProofConfig, readProofConfig } from './config-reader';
import {
  createProofDiagnosticFinding,
  getProofPackageIdentity,
} from './finding-utils';
import type { ProofFinding } from './findings';
import { isOrdinarySourceOwnershipCandidate } from './ownership-candidates';

interface SourceOwnerEntry {
  configPath: string;
  fileName: string;
}

function isDefaultTypecheckAggregator(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
}): boolean {
  if (path.basename(options.configPath) !== 'tsconfig.json') {
    return false;
  }

  return Object.hasOwn(
    readProofConfig(options.config, options.configPath),
    'references',
  );
}

function collectConfigOwnerEntries(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  generatedGraph: GeneratedTsconfigGraphResult;
  projectConfigCache?: CheckerProjectConfigCache;
}): SourceOwnerEntry[] {
  if (isDefaultTypecheckAggregator(options)) {
    return [];
  }

  const context = getActiveCheckerContext(
    options.config,
    options.generatedGraph,
  );

  return parseProofConfig({
    config: options.config,
    configPath: options.configPath,
    context,
    projectConfigCache: options.projectConfigCache,
  })
    .fileNames.filter(isOrdinarySourceOwnershipCandidate)
    .map((fileName) => ({ configPath: options.configPath, fileName }));
}

function collectFileOwners(options: {
  config: ResolvedLiminaConfig;
  generatedGraph: GeneratedTsconfigGraphResult;
  ordinaryConfigPaths: string[];
  projectConfigCache?: CheckerProjectConfigCache;
}): Map<string, string[]> {
  const fileOwners = new Map<string, string[]>();
  const entries = options.ordinaryConfigPaths.flatMap((configPath) =>
    collectConfigOwnerEntries({
      config: options.config,
      configPath,
      generatedGraph: options.generatedGraph,
    }),
  );

  for (const entry of entries) {
    const owners = fileOwners.get(entry.fileName) ?? [];

    owners.push(entry.configPath);
    fileOwners.set(entry.fileName, owners);
  }

  return fileOwners;
}

function getCheckerNamesForOwners(
  generatedGraph: GeneratedTsconfigGraphResult,
  ownerPaths: string[],
): string[] {
  return uniqueCodeUnitSortedStrings(
    [...generatedGraph.sourceToBuild].flatMap(([checkerName, sourceToBuild]) =>
      ownerPaths.some((configPath) => sourceToBuild.has(configPath))
        ? [checkerName]
        : [],
    ),
  );
}

function addDuplicateTypecheckOwnerFinding(options: {
  config: ResolvedLiminaConfig;
  fileName: string;
  findings: ProofFinding[];
  generatedGraph: GeneratedTsconfigGraphResult;
  owners: string[];
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const uniqueOwners = uniqueValues(options.owners);

  if (uniqueOwners.length <= 1) {
    return;
  }

  const sortedOwners = uniqueOwners.sort((left, right) =>
    compareCodeUnits(
      toRelativePath(options.config.rootDir, left),
      toRelativePath(options.config.rootDir, right),
    ),
  );
  const reason =
    'each implementation source file must belong to exactly one tsconfig*.json typecheck leaf.';
  const detailLines = [
    'Source file belongs to multiple typecheck configs:',
    `  file: ${toRelativePath(options.config.rootDir, options.fileName)}`,
    '  typecheck configs:',
    ...sortedOwners.map(
      (owner) => `    - ${toRelativePath(options.config.rootDir, owner)}`,
    ),
    `  reason: ${reason}`,
  ];

  options.findings.push(
    createProofDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.proofDuplicateSourceOwner,
      detailLines,
      evidence: [
        { label: 'diagnostic', lines: [...detailLines] },
        ...sortedOwners.map((projectPath) => ({
          label: 'owner project',
          value: projectPath,
        })),
      ],
      facts: {
        checkerNames: getCheckerNamesForOwners(
          options.generatedGraph,
          sortedOwners,
        ),
        kind: 'multiple-typecheck-owners',
        ownerProjectPaths: sortedOwners,
        sourcePath: options.fileName,
      },
      filePath: options.fileName,
      locations: [
        { filePath: options.fileName, label: 'source' },
        ...sortedOwners.map((projectPath) => ({
          filePath: projectPath,
          label: 'owner project',
        })),
      ],
      packageIdentity: getProofPackageIdentity(
        options.workspaceLookup,
        options.fileName,
      ),
      reason,
      title: 'Source file belongs to multiple typecheck configs',
    }),
  );
}

export function addDuplicateTypecheckOwnershipFindings(options: {
  config: ResolvedLiminaConfig;
  findings: ProofFinding[];
  generatedGraph: GeneratedTsconfigGraphResult;
  ordinaryConfigPaths: string[];
  projectConfigCache?: CheckerProjectConfigCache;
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const fileOwners = collectFileOwners(options);
  const entries = [...fileOwners].sort(([left], [right]) =>
    compareCodeUnits(
      toRelativePath(options.config.rootDir, left),
      toRelativePath(options.config.rootDir, right),
    ),
  );

  for (const [fileName, owners] of entries) {
    addDuplicateTypecheckOwnerFinding({
      config: options.config,
      fileName,
      findings: options.findings,
      generatedGraph: options.generatedGraph,
      owners,
      workspaceLookup: options.workspaceLookup,
    });
  }
}
