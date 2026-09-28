import { existsSync } from 'node:fs';

import type { ResolvedLiminaConfig } from '#config/runner';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { AllowlistEntry } from './allowlist-types';
import type { CoverageSource } from './coverage';
import {
  createProofFinding,
  type ProofFinding,
  type ProofFindingForCode,
} from './findings';

type EntryCoverageViolation =
  | 'already-covered'
  | 'missing-file'
  | 'outside-source-boundary';

interface AllowlistFindingOptions {
  baseCoverageByFile: ReadonlyMap<string, readonly CoverageSource[]>;
  config: ResolvedLiminaConfig;
  entry: AllowlistEntry;
  violation: EntryCoverageViolation;
}

const findingTitle: Record<EntryCoverageViolation, string> = {
  'already-covered':
    'Typecheck proof allowlist file is already covered without the allowlist',
  'missing-file': 'Typecheck proof allowlist references a missing file',
  'outside-source-boundary':
    'Typecheck proof allowlist file is outside the configured source boundary',
};

const findingReason: Record<EntryCoverageViolation, string> = {
  'already-covered':
    'Proof allowlist entries must describe source files that have no checker or graph coverage.',
  'missing-file':
    'Every proof allowlist entry must reference an existing file.',
  'outside-source-boundary':
    'allowlist entries should only describe source files that proof would otherwise require coverage for.',
};

function getCoverage(
  options: AllowlistFindingOptions,
): readonly CoverageSource[] {
  const coverage = options.baseCoverageByFile.get(options.entry.filePath);
  return coverage === undefined ? [] : coverage;
}

function createFindingDetailLines(options: AllowlistFindingOptions): string[] {
  const title = findingTitle[options.violation];
  const lines = [
    `${title}:`,
    `  file: ${toRelativePath(options.config.rootDir, options.entry.filePath)}`,
  ];

  if (options.violation === 'outside-source-boundary') {
    lines.push(`  reason: ${findingReason[options.violation]}`);
  }

  return lines;
}

function createFindingEvidence(
  options: AllowlistFindingOptions,
  detailLines: readonly string[],
) {
  const evidence = [{ label: 'diagnostic', lines: [...detailLines] }];

  if (options.violation !== 'already-covered') {
    return evidence;
  }

  return [
    ...evidence,
    ...getCoverage(options).map((source) => ({
      label: 'existing coverage',
      value: source.label,
    })),
  ];
}

function createAllowlistFinding(
  options: AllowlistFindingOptions,
): ProofFindingForCode<typeof LIMINA_CHECK_ISSUE_CODES.proofAllowlistInvalid> {
  const detailLines = createFindingDetailLines(options);
  const scope = `proof.allowlist[${options.entry.ruleIndex}]`;
  const coverage = getCoverage(options);

  return createProofFinding({
    code: LIMINA_CHECK_ISSUE_CODES.proofAllowlistInvalid,
    evidence: createFindingEvidence(options, detailLines),
    facts: {
      configuredPath: options.entry.configuredPath,
      coverage: [...coverage],
      kind: 'entry-coverage',
      repositoryRoot: normalizeAbsolutePath(options.config.rootDir),
      resolvedPath: options.entry.filePath,
      ruleIndex: options.entry.ruleIndex,
      sourcePath: options.entry.filePath,
      violation: options.violation,
    },
    filePath: options.entry.filePath,
    locations: [
      { filePath: options.entry.filePath, label: 'allowlist file' },
      {
        filePath: options.config.configPath,
        label: 'Limina config',
        scope,
      },
    ],
    presentation: {
      detailLines,
      title: findingTitle[options.violation],
    },
    reason: findingReason[options.violation],
    scope,
  });
}

interface AllowlistClassificationOptions {
  baseCoverageByFile: ReadonlyMap<string, readonly CoverageSource[]>;
  entry: AllowlistEntry;
  sourceFiles: ReadonlySet<string>;
}

type ViolationClassifier = (
  options: AllowlistClassificationOptions,
) => EntryCoverageViolation | null;

function classifyMissingFile(
  options: AllowlistClassificationOptions,
): EntryCoverageViolation | null {
  return existsSync(options.entry.filePath) ? null : 'missing-file';
}

function classifyOutsideBoundary(
  options: AllowlistClassificationOptions,
): EntryCoverageViolation | null {
  return options.sourceFiles.has(options.entry.filePath)
    ? null
    : 'outside-source-boundary';
}

function classifyExistingCoverage(
  options: AllowlistClassificationOptions,
): EntryCoverageViolation | null {
  return options.baseCoverageByFile.has(options.entry.filePath)
    ? 'already-covered'
    : null;
}

const violationClassifiers: readonly ViolationClassifier[] = [
  classifyMissingFile,
  classifyOutsideBoundary,
  classifyExistingCoverage,
];

function classifyAllowlistEntry(
  options: AllowlistClassificationOptions,
): EntryCoverageViolation | null {
  for (const classify of violationClassifiers) {
    const violation = classify(options);

    if (violation !== null) {
      return violation;
    }
  }

  return null;
}

export function collectAllowlistFindings(options: {
  allowlistEntries: readonly AllowlistEntry[];
  baseCoverageByFile: ReadonlyMap<string, readonly CoverageSource[]>;
  config: ResolvedLiminaConfig;
  sourceFiles: ReadonlySet<string>;
}): ProofFinding[] {
  const findings: ProofFinding[] = [];

  for (const entry of options.allowlistEntries) {
    const violation = classifyAllowlistEntry({
      baseCoverageByFile: options.baseCoverageByFile,
      entry,
      sourceFiles: options.sourceFiles,
    });

    if (violation === null) {
      continue;
    }

    findings.push(
      createAllowlistFinding({
        baseCoverageByFile: options.baseCoverageByFile,
        config: options.config,
        entry,
        violation,
      }),
    );
  }

  return findings;
}
