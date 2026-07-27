import { LIMINA_CHECK_ISSUE_CODES } from '../../../check-reporting/codes';
import type { LiminaCheckIssueEvidence } from '../../../check-reporting/snapshot';
import type {
  ReleaseContentHashFacts,
  ReleaseFindingFactsByCode,
  ReleasePackedManifestFacts,
  ReleaseRegistryFacts,
  ReleaseSemanticIssueCode,
  ReleaseTarballHygieneFacts,
} from './facts';
import type {
  CreateReleaseFindingOptions,
  ReleaseFindingForCode,
} from './types';

type EvidenceProperty = readonly [label: string, property: string];
type EvidenceFacts = ReleaseFindingFactsByCode[ReleaseSemanticIssueCode];
type EvidenceBuilder = (
  evidence: LiminaCheckIssueEvidence[],
  facts: EvidenceFacts,
) => void;

const scalarValueTypes = new Set(['boolean', 'number', 'string']);

function serializeComplexValue(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function serializeUnknown(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return scalarValueTypes.has(typeof value)
    ? String(value)
    : serializeComplexValue(value);
}

function pushEvidenceValue(
  evidence: LiminaCheckIssueEvidence[],
  label: string,
  value: unknown,
): void {
  const serialized = serializeUnknown(value);

  if (serialized === undefined) {
    return;
  }

  if (serialized === '') {
    return;
  }

  evidence.push({ label, value: serialized });
}

function getProperty(facts: object, property: string): unknown {
  return property in facts
    ? (facts as Record<string, unknown>)[property]
    : undefined;
}

function appendProperties(
  evidence: LiminaCheckIssueEvidence[],
  facts: object,
  properties: readonly EvidenceProperty[],
): void {
  for (const [label, property] of properties) {
    pushEvidenceValue(evidence, label, getProperty(facts, property));
  }
}

const packedManifestProperties: readonly EvidenceProperty[] = [
  ['dependency', 'dependencyName'],
  ['dependency section', 'sectionName'],
  ['dependency specifier', 'specifier'],
  ['source manifest', 'sourceManifestPath'],
  ['target manifest', 'targetManifestPath'],
  ['packed manifest', 'packedManifestPath'],
  ['package manifest', 'packageManifestPath'],
];

function appendRangeMismatchEvidence(
  evidence: LiminaCheckIssueEvidence[],
  facts: ReleasePackedManifestFacts,
): void {
  if (facts.kind !== 'packed-dependency-range-mismatch') {
    return;
  }

  pushEvidenceValue(evidence, 'expected version', facts.expectedVersion);
  pushEvidenceValue(evidence, 'actual range', facts.actualRange);
}

function appendManifestLintEvidence(
  evidence: LiminaCheckIssueEvidence[],
  facts: ReleasePackedManifestFacts,
): void {
  if (facts.kind !== 'manifest-lint-failed') {
    return;
  }

  pushEvidenceValue(evidence, 'external rule', facts.lintRule);
  pushEvidenceValue(evidence, 'lint node', facts.lintNode);
  pushEvidenceValue(evidence, 'lint message', facts.lintMessage);
}

function appendPackedManifestEvidence(
  evidence: LiminaCheckIssueEvidence[],
  facts: ReleasePackedManifestFacts,
): void {
  appendProperties(evidence, facts, packedManifestProperties);
  appendRangeMismatchEvidence(evidence, facts);
  appendManifestLintEvidence(evidence, facts);
}

const tarballProperties: readonly EvidenceProperty[] = [
  ['tarball', 'tarballPath'],
  ['archive entry', 'archiveEntryPath'],
  ['package manifest', 'packageManifestPath'],
  ['parse error', 'errorMessage'],
];

function appendMissingFilesEvidence(
  evidence: LiminaCheckIssueEvidence[],
  facts: ReleaseTarballHygieneFacts,
): void {
  if (facts.kind === 'required-files-missing') {
    evidence.push({ label: 'missing files', lines: [...facts.missingFiles] });
  }
}

function appendTarballEvidence(
  evidence: LiminaCheckIssueEvidence[],
  facts: ReleaseTarballHygieneFacts,
): void {
  appendProperties(evidence, facts, tarballProperties);
  appendMissingFilesEvidence(evidence, facts);
}

const registryProperties: readonly EvidenceProperty[] = [
  ['registry', 'registryUrl'],
  ['dependency', 'dependencyName'],
  ['dist-tag', 'requestedDistTag'],
  ['version', 'requestedVersion'],
  ['http status', 'statusCode'],
  ['http status text', 'statusText'],
  ['tarball', 'tarballUrl'],
  ['integrity field', 'integrityField'],
  ['expected integrity', 'expectedIntegrity'],
  ['expected shasum', 'expectedShasum'],
  ['actual integrity', 'actualIntegrity'],
  ['actual shasum', 'actualShasum'],
  ['registry integrity', 'registryIntegrity'],
  ['registry shasum', 'registryShasum'],
  ['timeout ms', 'timeoutMs'],
  ['error', 'errorMessage'],
];

function appendRegistryEvidence(
  evidence: LiminaCheckIssueEvidence[],
  facts: ReleaseRegistryFacts,
): void {
  appendProperties(evidence, facts, registryProperties);
}

function createContentDiffLines(
  facts: Extract<ReleaseContentHashFacts, { kind: 'content-diff' }>,
): string[] {
  return facts.diffs.map((diff) =>
    [
      `${diff.kind}: ${diff.relativePath}`,
      diff.localHash === undefined ? undefined : `local=${diff.localHash}`,
      diff.remoteHash === undefined ? undefined : `remote=${diff.remoteHash}`,
    ]
      .filter((value): value is string => value !== undefined)
      .join(' '),
  );
}

function appendIgnoredDiffGroups(
  evidence: LiminaCheckIssueEvidence[],
  facts: Extract<ReleaseContentHashFacts, { kind: 'content-diff' }>,
): void {
  for (const group of facts.ignoredDiffGroups) {
    evidence.push({
      label: `ignored by ${group.ruleIdentity}`,
      lines: group.diffs.map((diff) => `${diff.kind}: ${diff.relativePath}`),
    });
  }
}

function appendContentDiffEvidence(
  evidence: LiminaCheckIssueEvidence[],
  facts: Extract<ReleaseContentHashFacts, { kind: 'content-diff' }>,
): void {
  appendProperties(evidence, facts, [
    ['baseline tag', 'baselineTag'],
    ['baseline version', 'baselineVersion'],
    ['local output', 'localOutputDirectory'],
    ['local version', 'localVersion'],
    ['tarball', 'tarballUrl'],
    ['integrity', 'integrity'],
  ]);
  evidence.push({
    label: 'content hash diffs',
    lines: createContentDiffLines(facts),
  });
  appendIgnoredDiffGroups(evidence, facts);
}

function appendContentHashEvidence(
  evidence: LiminaCheckIssueEvidence[],
  facts: ReleaseContentHashFacts,
): void {
  appendProperties(evidence, facts, [
    ['dependency', 'dependencyName'],
    ['source manifest', 'sourceManifestPath'],
  ]);

  if (facts.kind === 'config-invalid') {
    appendProperties(evidence, facts, [
      ['config field', 'configField'],
      ['error', 'errorMessage'],
    ]);
    return;
  }

  appendContentDiffEvidence(evidence, facts);
}

const evidenceBuilderByCode: Readonly<
  Record<ReleaseSemanticIssueCode, EvidenceBuilder>
> = {
  [LIMINA_CHECK_ISSUE_CODES.releaseContentHash]: (evidence, facts) =>
    appendContentHashEvidence(evidence, facts as ReleaseContentHashFacts),
  [LIMINA_CHECK_ISSUE_CODES.releasePackedManifest]: (evidence, facts) =>
    appendPackedManifestEvidence(evidence, facts as ReleasePackedManifestFacts),
  [LIMINA_CHECK_ISSUE_CODES.releaseRegistry]: (evidence, facts) =>
    appendRegistryEvidence(evidence, facts as ReleaseRegistryFacts),
  [LIMINA_CHECK_ISSUE_CODES.releaseTarballHygiene]: (evidence, facts) =>
    appendTarballEvidence(evidence, facts as ReleaseTarballHygieneFacts),
};

function createReleaseFindingEvidence<Code extends ReleaseSemanticIssueCode>(
  code: Code,
  facts: ReleaseFindingFactsByCode[Code],
): LiminaCheckIssueEvidence[] {
  const evidence: LiminaCheckIssueEvidence[] = [
    { label: 'release reason', value: facts.kind },
  ];
  evidenceBuilderByCode[code](evidence, facts);
  return evidence;
}

export function createReleaseFinding<Code extends ReleaseSemanticIssueCode>(
  options: CreateReleaseFindingOptions<Code>,
): ReleaseFindingForCode<Code> {
  return {
    code: options.code,
    evidence: createReleaseFindingEvidence(options.code, options.facts),
    external: options.external,
    facts: options.facts,
    filePath: options.filePath,
    locations: options.locations === undefined ? [] : [...options.locations],
    packageManifestPath: options.packageManifestPath,
    packageName: options.packageName,
    presentation: options.presentation,
    reason: options.facts.kind,
    task: 'release:check',
  } as ReleaseFindingForCode<Code>;
}
