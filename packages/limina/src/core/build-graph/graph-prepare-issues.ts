import type { ResolvedLiminaConfig } from '#config/runner';
import { LIMINA_CHECK_ISSUE_CODES } from '../../check-reporting/codes';
import {
  createTaskFailureIssue,
  type LiminaCheckIssue,
  type LiminaCheckIssueEvidence,
  type LiminaCheckIssueLocation,
} from '../../check-reporting/snapshot';
import {
  collectGeneratedGraphProblemBlockLines,
  createImportExampleEvidence,
  findGeneratedGraphProblemLineValue,
  getCheckerDescriptorName,
  isNonEmptyGeneratedGraphEvidence,
  isNonEmptyGeneratedGraphLocation,
} from './problem-parsing';

function getNonEmptyLocations(
  locations: readonly (LiminaCheckIssueLocation | undefined)[] | undefined,
): LiminaCheckIssueLocation[] | undefined {
  if (!locations) {
    return undefined;
  }
  const filtered = locations.filter(isNonEmptyGeneratedGraphLocation);
  return filtered.length > 0 ? filtered : undefined;
}

function createGraphPrepareIssue(options: {
  config: ResolvedLiminaConfig;
  detailLines: readonly string[];
  evidence: readonly (LiminaCheckIssueEvidence | undefined)[];
  filePath?: string;
  fix: string;
  locations?: readonly (LiminaCheckIssueLocation | undefined)[];
  reason: string;
  summary: string;
  title: string;
}): LiminaCheckIssue {
  const evidence = options.evidence.filter(isNonEmptyGeneratedGraphEvidence);

  return createTaskFailureIssue({
    code: LIMINA_CHECK_ISSUE_CODES.graphPrepareFailed,
    detailLines: options.detailLines,
    detector: 'graph-prepare',
    domain: 'graph',
    evidence,
    filePath: options.filePath,
    fix: options.fix,
    locations: getNonEmptyLocations(options.locations),
    reason: options.reason,
    rootDir: options.config.rootDir,
    summary: options.summary,
    task: 'graph:prepare',
    title: options.title,
    verifyCommands: ['limina graph prepare'],
  });
}

export function createUnsafeCrossEngineProviderIssue(options: {
  config: ResolvedLiminaConfig;
  lines: readonly string[];
}): LiminaCheckIssue {
  const consumer = findGeneratedGraphProblemLineValue(options.lines, [
    'consumer checker',
  ]);
  const consumerConfig = findGeneratedGraphProblemLineValue(options.lines, [
    'consumer config',
  ]);
  const targetConfig = findGeneratedGraphProblemLineValue(options.lines, [
    'target config',
  ]);
  const filePath = findGeneratedGraphProblemLineValue(options.lines, ['file']);
  const resolvedFile = findGeneratedGraphProblemLineValue(options.lines, [
    'resolved file',
  ]);
  const providerCandidates = collectGeneratedGraphProblemBlockLines(
    options.lines,
    'provider candidates',
  );

  return createGraphPrepareIssue({
    config: options.config,
    detailLines: options.lines,
    evidence: [
      consumer ? { label: 'consumer', value: consumer } : undefined,
      providerCandidates.length > 0
        ? { label: 'provider candidates', lines: providerCandidates }
        : undefined,
      createImportExampleEvidence(options.lines, ['target config']),
    ],
    filePath,
    fix: 'Make the target config owned by the consumer checker, choose one build checker owner, or split the dependency through an explicit declaration/artifact boundary.',
    locations: [
      { filePath: consumerConfig, label: 'consumer config' },
      { filePath: targetConfig, label: 'target config' },
      { filePath: resolvedFile, label: 'resolved file' },
    ],
    reason:
      'Generated project references must not cross checker build-engine boundaries in V1.',
    summary: `${getCheckerDescriptorName(consumer)} cannot use provider candidates from different build engines.`,
    title: 'Unsafe cross-engine declaration provider',
  });
}

export function createAmbiguousCrossCheckerProviderIssue(options: {
  config: ResolvedLiminaConfig;
  lines: readonly string[];
}): LiminaCheckIssue {
  const consumerConfig = findGeneratedGraphProblemLineValue(options.lines, [
    'consumer config',
  ]);
  const targetConfig = findGeneratedGraphProblemLineValue(options.lines, [
    'target config',
  ]);
  const filePath = findGeneratedGraphProblemLineValue(options.lines, ['file']);
  const resolvedFile = findGeneratedGraphProblemLineValue(options.lines, [
    'resolved file',
  ]);
  const candidates = collectGeneratedGraphProblemBlockLines(
    options.lines,
    'candidates',
  );

  return createGraphPrepareIssue({
    config: options.config,
    detailLines: options.lines,
    evidence: [
      candidates.length > 0
        ? { label: 'candidates', lines: candidates }
        : undefined,
      createImportExampleEvidence(options.lines),
    ],
    filePath,
    fix: 'Make checker ownership unambiguous with config.checkers.<checker>.include/exclude.',
    locations: [
      { filePath: consumerConfig, label: 'consumer config' },
      { filePath: targetConfig, label: 'target config' },
      { filePath: resolvedFile, label: 'resolved file' },
    ],
    reason: 'Limina cannot choose a stable generated declaration provider.',
    summary:
      'Multiple build-capable provider checkers can own the resolved file.',
    title: 'Ambiguous cross-checker declaration provider',
  });
}

export function createOutputBuildCacheBoundaryConflictIssue(options: {
  config: ResolvedLiminaConfig;
  lines: readonly string[];
}): LiminaCheckIssue {
  const sourceConfig = findGeneratedGraphProblemLineValue(options.lines, [
    'config',
  ]);
  const outputTsBuildInfo = findGeneratedGraphProblemLineValue(options.lines, [
    'output tsbuildinfo',
  ]);
  const buildOwners = collectGeneratedGraphProblemBlockLines(
    options.lines,
    'build owners',
  );

  return createGraphPrepareIssue({
    config: options.config,
    detailLines: options.lines,
    evidence: [
      buildOwners.length > 0
        ? { label: 'build owners', lines: buildOwners }
        : undefined,
    ],
    filePath: sourceConfig,
    fix: 'Choose one output build checker owner for this config, or split output-enabled configs so each output build boundary has one owner.',
    locations: [
      { filePath: sourceConfig, label: 'source config' },
      { filePath: outputTsBuildInfo, label: 'output tsbuildinfo' },
    ],
    reason:
      'Generated output build info is keyed by source config path and is not checker-namespaced.',
    summary:
      'Multiple checkers would generate output build configs for the same output-enabled source config.',
    title: 'Output build cache boundary conflict',
  });
}
