import { isBuildCapablePreset } from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import {
  compareCodeUnits,
  uniqueCodeUnitSortedStrings,
} from '#utils/collections';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import {
  createProofDiagnosticFinding,
  getProofPackageIdentity,
} from './finding-utilities';
import type { ProofFinding } from './findings';
import type {
  FrameworkGovernanceProofFacts,
  GovernedSourceEntry,
} from './framework-governance-types';

export interface FrameworkGovernanceFindingOptions {
  checkerName?: string;
  config: ResolvedLiminaConfig;
  configPath: string;
  detailLines: readonly string[];
  facts: FrameworkGovernanceProofFacts;
  findings: ProofFinding[];
  hint?: string;
  reason: string;
  title: string;
  workspaceLookup: WorkspaceLookupIndex;
}

export interface FrameworkCoverageOptions {
  config: ResolvedLiminaConfig;
  entries: readonly GovernedSourceEntry[];
  findings: ProofFinding[];
  generatedGraph: GeneratedTsconfigGraphResult;
  workspaceLookup: WorkspaceLookupIndex;
}

export function addFrameworkGovernanceFinding(
  options: FrameworkGovernanceFindingOptions,
): void {
  options.findings.push(
    createProofDiagnosticFinding({
      checkerName: options.checkerName,
      code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
      detailLines: options.detailLines,
      facts: options.facts,
      filePath: options.configPath,
      hint: options.hint,
      locations: [{ filePath: options.configPath, label: 'source config' }],
      packageIdentity: getProofPackageIdentity(
        options.workspaceLookup,
        options.configPath,
      ),
      reason: options.reason,
      title: options.title,
    }),
  );
}

export function collectGovernedSourceEntries(
  generatedGraph: GeneratedTsconfigGraphResult,
): GovernedSourceEntry[] {
  return [...generatedGraph.governedSources]
    .flatMap(([checkerName, units]) =>
      units
        .values()
        .map((unit) => ({ checkerName, unit }))
        .toArray(),
    )
    .sort(
      (left, right) =>
        compareCodeUnits(left.unit.configPath, right.unit.configPath) ||
        compareCodeUnits(left.checkerName, right.checkerName),
    );
}

export function isPrimaryBuildEntry(entry: GovernedSourceEntry): boolean {
  return isBuildCapablePreset(entry.unit.primaryCheckerName);
}

export function getExpectedBuildProjectionKind(
  entry: GovernedSourceEntry,
): GovernedSourceEntry['unit']['buildProjection']['kind'] {
  return isBuildCapablePreset(entry.unit.primaryCheckerName)
    ? getExpectedBuildCapableProjectionKind(entry)
    : 'framework-checker';
}

function getExpectedBuildCapableProjectionKind(
  entry: GovernedSourceEntry,
): GovernedSourceEntry['unit']['buildProjection']['kind'] {
  if (entry.unit.frameworkCapabilities.length === 0) {
    return 'declaration-project';
  }
  return entry.unit.declarationFileNames.length === 0
    ? 'transparent-solution'
    : 'wrapped-project';
}

function isUnsupportedGeneratedEntry(value: string): boolean {
  return /\.(?:astro|svelte)(?:$|[/?#])/u.test(value);
}

export function collectUnsupportedFrameworkEntries(configObject: {
  files?: unknown;
  include?: unknown;
}): string[] {
  return uniqueCodeUnitSortedStrings(
    [configObject.files, configObject.include].flatMap((value) =>
      Array.isArray(value)
        ? value.filter(
            (entry): entry is string =>
              typeof entry === 'string' && isUnsupportedGeneratedEntry(entry),
          )
        : [],
    ),
  );
}

export function groupEntriesByConfigPath(
  entries: readonly GovernedSourceEntry[],
): Map<string, GovernedSourceEntry[]> {
  return Map.groupBy(entries, (entry) => entry.unit.configPath);
}
