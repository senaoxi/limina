import type { ResolvedLiminaConfig } from '#config/runner';
import { uniqueSortedStrings, uniqueValues } from '#utils/collections';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { LiminaCheckIssueLocation } from '../check-reporting/snapshot';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import type { CoverageSource } from './coverage';
import {
  createProofDiagnosticFinding,
  getProofPackageIdentity,
} from './finding-utils';
import type { ProofFinding } from './findings';
import type { CheckerCoverageTarget } from './runner-types';

function getSourceConfig(config: ResolvedLiminaConfig) {
  return config.config?.source;
}

function getConfiguredSourceIncludes(config: ResolvedLiminaConfig): string[] {
  const sourceConfig = getSourceConfig(config);

  if (!sourceConfig?.include) {
    return ['...'];
  }

  return [...sourceConfig.include];
}

function getConfiguredSourceExcludes(config: ResolvedLiminaConfig): string[] {
  const sourceConfig = getSourceConfig(config);

  if (!sourceConfig?.exclude) {
    return [];
  }

  return [...sourceConfig.exclude];
}

interface UncoveredFindingContext {
  candidateCheckerNames: string[];
  candidateProjectPaths: string[];
  config: ResolvedLiminaConfig;
  findings: ProofFinding[];
  workspaceLookup: WorkspaceLookupIndex;
}

function addUncoveredFileFinding(
  context: UncoveredFindingContext,
  filePath: string,
): void {
  const reason =
    'Every file in config.source must be covered by a checker entry or an explicit allowlist entry.';
  const hint =
    'Add the file to a checker entry, exclude it from config.source, or add an explicit proof.allowlist entry with a reason.';

  context.findings.push(
    createProofDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile,
      detailLines: [],
      evidence: [
        { label: 'source', value: filePath },
        ...context.candidateCheckerNames.map((checkerName) => ({
          label: 'candidate checker',
          value: checkerName,
        })),
        ...context.candidateProjectPaths.map((projectPath) => ({
          label: 'candidate project',
          value: projectPath,
        })),
      ],
      facts: {
        candidateCheckerNames: context.candidateCheckerNames,
        candidateProjectPaths: context.candidateProjectPaths,
        configuredSourceExcludes: getConfiguredSourceExcludes(context.config),
        configuredSourceIncludes: getConfiguredSourceIncludes(context.config),
        coverage: [],
        kind: 'no-checker-or-allowlist-coverage',
        sourcePath: filePath,
      },
      filePath,
      hint,
      locations: [{ filePath, label: 'uncovered source' }],
      packageIdentity: getProofPackageIdentity(
        context.workspaceLookup,
        filePath,
      ),
      reason,
      title: 'Source file is not covered by typecheck proof',
    }),
  );
}

export function addUncoveredSourceFindings(options: {
  checkerTargets: CheckerCoverageTarget[];
  config: ResolvedLiminaConfig;
  coverageByFile: Map<string, CoverageSource[]>;
  findings: ProofFinding[];
  sourceFiles: Set<string>;
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const uncoveredFiles = [...options.sourceFiles].filter(
    (filePath) => !options.coverageByFile.has(filePath),
  );
  const context: UncoveredFindingContext = {
    candidateCheckerNames: uniqueSortedStrings(
      options.checkerTargets.map((target) => target.checker.name),
    ),
    candidateProjectPaths: uniqueSortedStrings(
      options.checkerTargets.flatMap((target) => target.coverageConfigPaths),
    ),
    config: options.config,
    findings: options.findings,
    workspaceLookup: options.workspaceLookup,
  };

  for (const filePath of uncoveredFiles) {
    addUncoveredFileFinding(context, filePath);
  }
}

function formatCoverageLines(
  config: ResolvedLiminaConfig,
  entries: [string, CoverageSource[]][],
): string[] {
  return entries.slice(0, 20).flatMap(([filePath, sources]) => {
    const overflow = sources.length - 3;

    return [
      `  - ${toRelativePath(config.rootDir, filePath)}`,
      ...sources.slice(0, 3).map((source) => `    covered by: ${source.label}`),
      ...(overflow > 0 ? [`    ... ${overflow} more`] : []),
    ];
  });
}

function collectCoverageLocations(
  entries: [string, CoverageSource[]][],
): LiminaCheckIssueLocation[] {
  const paths = uniqueValues(
    entries.flatMap(([filePath, sources]) => [
      filePath,
      ...sources.flatMap((source) =>
        'projectPath' in source ? [source.projectPath] : [],
      ),
    ]),
  );

  return paths.map((filePath) => ({
    filePath,
    label: 'source or covering project',
  }));
}

interface BoundarySourceFact {
  coverage: CoverageSource[];
  packageManifestPath?: string;
  packageName?: string;
  packageRoot?: string;
  sourcePath: string;
}

function getSourceOwnerFact(
  workspaceLookup: WorkspaceLookupIndex,
  sourcePath: string,
): Pick<
  BoundarySourceFact,
  'packageManifestPath' | 'packageName' | 'packageRoot'
> {
  const owner = workspaceLookup.findOwnerForFile(sourcePath);

  return owner
    ? {
        packageManifestPath: owner.packageJsonPath,
        packageName: owner.name,
        packageRoot: owner.directory,
      }
    : {};
}

function createBoundarySourceFact(
  workspaceLookup: WorkspaceLookupIndex,
  sourcePath: string,
  coverage: CoverageSource[],
): BoundarySourceFact {
  return {
    coverage: [...coverage],
    ...getSourceOwnerFact(workspaceLookup, sourcePath),
    sourcePath,
  };
}

export function addSourceBoundaryMismatchFindings(options: {
  config: ResolvedLiminaConfig;
  findings: ProofFinding[];
  outsideSourceCoverageByFile: Map<string, CoverageSource[]>;
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const outsideSourceFiles = [
    ...options.outsideSourceCoverageByFile.entries(),
  ].sort(([left], [right]) => left.localeCompare(right));

  if (outsideSourceFiles.length === 0) {
    return;
  }

  const reason =
    'config.source and tsconfig*.json coverage describe different module sets.';
  const hint =
    'Include these files in config.source, exclude them from the related tsconfig*.json, or move intentionally unmanaged files out of checker coverage.';
  const overflow = outsideSourceFiles.length - 20;
  const detailLines = [
    'Typecheck proof source boundary does not match tsconfig coverage:',
    ...formatCoverageLines(options.config, outsideSourceFiles),
    ...(overflow > 0 ? [`  ... ${overflow} more`] : []),
    `  reason: ${reason}`,
    `  fix: ${hint.charAt(0).toLowerCase()}${hint.slice(1)}`,
  ];

  options.findings.push(
    createProofDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.proofSourceBoundaryMismatch,
      detailLines,
      evidence: [
        { label: 'diagnostic', lines: [...detailLines] },
        ...outsideSourceFiles.flatMap(([filePath, sources]) =>
          sources.map((source) => ({
            label: 'coverage',
            value: `${filePath} <- ${source.label}`,
          })),
        ),
      ],
      facts: {
        configuredSourceExcludes: getConfiguredSourceExcludes(options.config),
        configuredSourceIncludes: getConfiguredSourceIncludes(options.config),
        kind: 'coverage-outside-source-boundary',
        repositoryRoot: normalizeAbsolutePath(options.config.rootDir),
        sources: outsideSourceFiles.map(([sourcePath, coverage]) =>
          createBoundarySourceFact(
            options.workspaceLookup,
            sourcePath,
            coverage,
          ),
        ),
      },
      hint,
      locations: collectCoverageLocations(outsideSourceFiles),
      reason,
      title: 'Typecheck proof source boundary does not match tsconfig coverage',
    }),
  );
}
