import { toRelativePath } from '#utils/path';
import {
  LIMINA_CHECK_ISSUE_CODES,
  type LiminaWritableCheckIssueCode,
} from '../check-reporting/codes';
import {
  type CanonicalLiminaCheckIssue,
  createTaskFailureIssue,
  type LiminaCheckIssueEvidence,
  type LiminaCheckIssueExternal,
  type LiminaCheckIssueLocation,
} from '../check-reporting/snapshot';

export type ReleaseSemanticIssueCode =
  | typeof LIMINA_CHECK_ISSUE_CODES.releaseContentHash
  | typeof LIMINA_CHECK_ISSUE_CODES.releasePackedManifest
  | typeof LIMINA_CHECK_ISSUE_CODES.releaseRegistry
  | typeof LIMINA_CHECK_ISSUE_CODES.releaseTarballHygiene;

export const RELEASE_SEMANTIC_ISSUE_CODES: readonly ReleaseSemanticIssueCode[] =
  [
    LIMINA_CHECK_ISSUE_CODES.releaseContentHash,
    LIMINA_CHECK_ISSUE_CODES.releasePackedManifest,
    LIMINA_CHECK_ISSUE_CODES.releaseRegistry,
    LIMINA_CHECK_ISSUE_CODES.releaseTarballHygiene,
  ] satisfies readonly LiminaWritableCheckIssueCode[];

export type ReleaseDependencySectionName =
  | 'dependencies'
  | 'devDependencies'
  | 'optionalDependencies'
  | 'peerDependencies';

export type ReleaseContentHashDiffKind =
  | 'changed'
  | 'local-only'
  | 'remote-only';

export interface ReleaseContentHashFileDiff {
  readonly kind: ReleaseContentHashDiffKind;
  readonly localHash?: string;
  readonly relativePath: string;
  readonly remoteHash?: string;
}

export interface ReleaseIgnoredContentHashDiffGroup {
  readonly diffs: readonly ReleaseContentHashFileDiff[];
  readonly ruleIdentity: string;
}

export type ReleasePackedManifestFacts =
  | {
      readonly dependencyName: string;
      readonly kind: 'output-local-specifier';
      readonly outputDirectory: string;
      readonly packageManifestPath: string;
      readonly sectionName: ReleaseDependencySectionName;
      readonly specifier: string;
    }
  | {
      readonly dependencyName: string;
      readonly importerName: string;
      readonly kind: 'source-link-dependency';
      readonly sourceManifestPath: string;
      readonly sectionName: Exclude<
        ReleaseDependencySectionName,
        'devDependencies'
      >;
      readonly specifier: string;
    }
  | {
      readonly dependencyName: string;
      readonly importerName: string;
      readonly kind: 'source-private-dependency';
      readonly sectionName: Exclude<
        ReleaseDependencySectionName,
        'devDependencies'
      >;
      readonly sourceManifestPath: string;
      readonly specifier: string;
      readonly targetManifestPath: string;
    }
  | {
      readonly dependencyName: string;
      readonly importerName: string;
      readonly kind: 'source-workspace-dependency-missing';
      readonly sectionName: Exclude<
        ReleaseDependencySectionName,
        'devDependencies'
      >;
      readonly sourceManifestPath: string;
      readonly specifier: string;
    }
  | {
      readonly dependencyName: string;
      readonly importerName: string;
      readonly kind:
        | 'packed-local-specifier'
        | 'packed-publish-local-specifier';
      readonly packedManifestPath: string;
      readonly sectionName: ReleaseDependencySectionName;
      readonly specifier: string;
    }
  | {
      readonly dependencyName: string;
      readonly importerName: string;
      readonly kind: 'packed-dependency-missing';
      readonly packedManifestPath: string;
      readonly sectionName: Exclude<
        ReleaseDependencySectionName,
        'devDependencies'
      >;
    }
  | {
      readonly actualRange: string;
      readonly dependencyName: string;
      readonly expectedVersion?: string;
      readonly importerName: string;
      readonly kind: 'packed-dependency-range-mismatch';
      readonly packedManifestPath: string;
      readonly sectionName: Exclude<
        ReleaseDependencySectionName,
        'devDependencies'
      >;
    }
  | {
      readonly kind: 'manifest-lint-failed';
      readonly lintMessage: string;
      readonly lintNode: string;
      readonly lintRule: string;
      readonly packedManifestPath: string;
    };

export type ReleaseTarballHygieneFacts =
  | {
      readonly kind: 'output-private';
      readonly packageManifestPath: string;
    }
  | {
      readonly archiveEntryPath: string;
      readonly kind: 'package-json-missing';
      readonly tarballPath: string;
    }
  | {
      readonly archiveEntryPath: string;
      readonly errorMessage: string;
      readonly kind: 'package-json-invalid';
      readonly tarballPath: string;
    }
  | {
      readonly kind: 'required-files-missing';
      readonly missingFiles: readonly string[];
      readonly tarballPath: string;
    }
  | {
      readonly archiveEntryPath: string;
      readonly kind: 'source-map-file' | 'source-mapping-url';
      readonly tarballPath: string;
    };

export type ReleaseRegistryReason =
  | 'comparison-failed'
  | 'dist-tag-missing'
  | 'integrity-invalid'
  | 'integrity-mismatch'
  | 'integrity-missing'
  | 'metadata-body-read'
  | 'metadata-http-status'
  | 'metadata-invalid-json'
  | 'metadata-invalid-object'
  | 'metadata-request'
  | 'metadata-timeout'
  | 'package-not-found'
  | 'tarball-body-read'
  | 'tarball-http-status'
  | 'tarball-request'
  | 'tarball-timeout'
  | 'tarball-url-missing'
  | 'version-missing';

export interface ReleaseRegistryFacts {
  readonly actualIntegrity?: string;
  readonly actualShasum?: string;
  readonly dependencyName: string;
  readonly errorMessage?: string;
  readonly expectedIntegrity?: string;
  readonly expectedShasum?: string;
  readonly importerName: string;
  readonly integrityField?: 'integrity' | 'shasum';
  readonly integritySource?: 'integrity' | 'shasum';
  readonly kind: ReleaseRegistryReason;
  readonly registryUrl: string;
  readonly requestedDistTag?: string;
  readonly requestedVersion?: string;
  readonly registryIntegrity?: unknown;
  readonly registryShasum?: unknown;
  readonly statusCode?: number;
  readonly statusText?: string;
  readonly tarballUrl?: string;
  readonly timeoutMs?: number;
}

export type ReleaseContentHashFacts =
  | {
      readonly configField:
        | 'release.contentHash.baselineTag'
        | 'release.contentHash.ignore';
      readonly dependencyName: string;
      readonly errorMessage: string;
      readonly importerName: string;
      readonly kind: 'config-invalid';
      readonly policy: {
        readonly baselineTag?: unknown;
        readonly builtinIgnore?: unknown;
        readonly ignore?: unknown;
      };
      readonly sourceManifestPath: string;
    }
  | {
      readonly baselineTag: string;
      readonly baselineVersion: string;
      readonly dependencyName: string;
      readonly diffs: readonly ReleaseContentHashFileDiff[];
      readonly ignoredDiffGroups: readonly ReleaseIgnoredContentHashDiffGroup[];
      readonly importerName: string;
      readonly integrity: string;
      readonly integritySource: 'integrity' | 'shasum';
      readonly kind: 'content-diff';
      readonly localOutputDirectory: string;
      readonly localVersion?: string;
      readonly sourceManifestPath: string;
      readonly tarballUrl: string;
    };

export interface ReleaseFindingFactsByCode {
  readonly [LIMINA_CHECK_ISSUE_CODES.releaseContentHash]: ReleaseContentHashFacts;
  readonly [LIMINA_CHECK_ISSUE_CODES.releasePackedManifest]: ReleasePackedManifestFacts;
  readonly [LIMINA_CHECK_ISSUE_CODES.releaseRegistry]: ReleaseRegistryFacts;
  readonly [LIMINA_CHECK_ISSUE_CODES.releaseTarballHygiene]: ReleaseTarballHygieneFacts;
}

export type ReleaseFindingSection =
  | 'output-manifest'
  | 'packed-lint'
  | 'packed-manifest'
  | 'registry-content'
  | 'source-link'
  | 'source-private'
  | 'source-workspace'
  | 'tarball';

export interface ReleaseFindingPresentation {
  readonly problemLines: readonly string[];
  readonly section: ReleaseFindingSection;
  readonly sectionTitle: string;
  readonly summary: string;
  readonly title: string;
}

interface ReleaseFindingBase<Code extends ReleaseSemanticIssueCode> {
  readonly code: Code;
  readonly evidence: readonly LiminaCheckIssueEvidence[];
  readonly external?: LiminaCheckIssueExternal;
  readonly facts: ReleaseFindingFactsByCode[Code];
  readonly filePath?: string;
  readonly locations: readonly LiminaCheckIssueLocation[];
  readonly packageManifestPath: string;
  readonly packageName: string;
  readonly presentation: ReleaseFindingPresentation;
  readonly reason: ReleaseFindingFactsByCode[Code]['kind'];
  readonly task: 'release:check';
}

export type ReleaseFindingForCode<Code extends ReleaseSemanticIssueCode> =
  ReleaseFindingBase<Code>;

export type ReleaseFinding = {
  readonly [Code in ReleaseSemanticIssueCode]: ReleaseFindingForCode<Code>;
}[ReleaseSemanticIssueCode];

interface CreateReleaseFindingOptions<Code extends ReleaseSemanticIssueCode> {
  readonly code: Code;
  readonly external?: LiminaCheckIssueExternal;
  readonly facts: ReleaseFindingFactsByCode[Code];
  readonly filePath?: string;
  readonly locations?: readonly LiminaCheckIssueLocation[];
  readonly packageManifestPath: string;
  readonly packageName: string;
  readonly presentation: ReleaseFindingPresentation;
}

function pushEvidenceValue(
  evidence: LiminaCheckIssueEvidence[],
  label: string,
  value: string | number | undefined,
): void {
  if (value === undefined || value === '') {
    return;
  }

  evidence.push({ label, value: String(value) });
}

function pushUnknownEvidenceValue(
  evidence: LiminaCheckIssueEvidence[],
  label: string,
  value: unknown,
): void {
  if (value === undefined) {
    return;
  }

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    pushEvidenceValue(evidence, label, String(value));
    return;
  }

  try {
    pushEvidenceValue(evidence, label, JSON.stringify(value));
  } catch {
    pushEvidenceValue(evidence, label, String(value));
  }
}

function createReleaseFindingEvidence<Code extends ReleaseSemanticIssueCode>(
  code: Code,
  facts: ReleaseFindingFactsByCode[Code],
): LiminaCheckIssueEvidence[] {
  const evidence: LiminaCheckIssueEvidence[] = [
    { label: 'release reason', value: facts.kind },
  ];

  if (code === LIMINA_CHECK_ISSUE_CODES.releasePackedManifest) {
    const packedFacts = facts as ReleasePackedManifestFacts;

    if ('dependencyName' in packedFacts) {
      pushEvidenceValue(evidence, 'dependency', packedFacts.dependencyName);
    }
    if ('sectionName' in packedFacts) {
      pushEvidenceValue(
        evidence,
        'dependency section',
        packedFacts.sectionName,
      );
    }
    if ('specifier' in packedFacts) {
      pushEvidenceValue(
        evidence,
        'dependency specifier',
        packedFacts.specifier,
      );
    }
    if ('sourceManifestPath' in packedFacts) {
      pushEvidenceValue(
        evidence,
        'source manifest',
        packedFacts.sourceManifestPath,
      );
    }
    if ('targetManifestPath' in packedFacts) {
      pushEvidenceValue(
        evidence,
        'target manifest',
        packedFacts.targetManifestPath,
      );
    }
    if ('packedManifestPath' in packedFacts) {
      pushEvidenceValue(
        evidence,
        'packed manifest',
        packedFacts.packedManifestPath,
      );
    }
    if ('packageManifestPath' in packedFacts) {
      pushEvidenceValue(
        evidence,
        'package manifest',
        packedFacts.packageManifestPath,
      );
    }
    if (packedFacts.kind === 'packed-dependency-range-mismatch') {
      pushEvidenceValue(
        evidence,
        'expected version',
        packedFacts.expectedVersion,
      );
      pushEvidenceValue(evidence, 'actual range', packedFacts.actualRange);
    }
    if (packedFacts.kind === 'manifest-lint-failed') {
      pushEvidenceValue(evidence, 'external rule', packedFacts.lintRule);
      pushEvidenceValue(evidence, 'lint node', packedFacts.lintNode);
      pushEvidenceValue(evidence, 'lint message', packedFacts.lintMessage);
    }
  }

  if (code === LIMINA_CHECK_ISSUE_CODES.releaseTarballHygiene) {
    const tarballFacts = facts as ReleaseTarballHygieneFacts;

    if ('tarballPath' in tarballFacts) {
      pushEvidenceValue(evidence, 'tarball', tarballFacts.tarballPath);
    }
    if ('archiveEntryPath' in tarballFacts) {
      pushEvidenceValue(
        evidence,
        'archive entry',
        tarballFacts.archiveEntryPath,
      );
    }
    if (tarballFacts.kind === 'required-files-missing') {
      evidence.push({
        label: 'missing files',
        lines: [...tarballFacts.missingFiles],
      });
    }
    if (tarballFacts.kind === 'output-private') {
      pushEvidenceValue(
        evidence,
        'package manifest',
        tarballFacts.packageManifestPath,
      );
    }
    if (tarballFacts.kind === 'package-json-invalid') {
      pushEvidenceValue(evidence, 'parse error', tarballFacts.errorMessage);
    }
  }

  if (code === LIMINA_CHECK_ISSUE_CODES.releaseRegistry) {
    const registryFacts = facts as ReleaseRegistryFacts;

    pushEvidenceValue(evidence, 'registry', registryFacts.registryUrl);
    pushEvidenceValue(evidence, 'dependency', registryFacts.dependencyName);
    pushEvidenceValue(evidence, 'dist-tag', registryFacts.requestedDistTag);
    pushEvidenceValue(evidence, 'version', registryFacts.requestedVersion);
    pushEvidenceValue(evidence, 'http status', registryFacts.statusCode);
    pushEvidenceValue(evidence, 'http status text', registryFacts.statusText);
    pushEvidenceValue(evidence, 'tarball', registryFacts.tarballUrl);
    pushEvidenceValue(
      evidence,
      'integrity field',
      registryFacts.integrityField,
    );
    pushEvidenceValue(
      evidence,
      'expected integrity',
      registryFacts.expectedIntegrity,
    );
    pushEvidenceValue(
      evidence,
      'expected shasum',
      registryFacts.expectedShasum,
    );
    pushEvidenceValue(
      evidence,
      'actual integrity',
      registryFacts.actualIntegrity,
    );
    pushEvidenceValue(evidence, 'actual shasum', registryFacts.actualShasum);
    pushUnknownEvidenceValue(
      evidence,
      'registry integrity',
      registryFacts.registryIntegrity,
    );
    pushUnknownEvidenceValue(
      evidence,
      'registry shasum',
      registryFacts.registryShasum,
    );
    pushEvidenceValue(evidence, 'timeout ms', registryFacts.timeoutMs);
    pushEvidenceValue(evidence, 'error', registryFacts.errorMessage);
  }

  if (code === LIMINA_CHECK_ISSUE_CODES.releaseContentHash) {
    const contentHashFacts = facts as ReleaseContentHashFacts;

    pushEvidenceValue(evidence, 'dependency', contentHashFacts.dependencyName);
    pushEvidenceValue(
      evidence,
      'source manifest',
      contentHashFacts.sourceManifestPath,
    );

    if (contentHashFacts.kind === 'config-invalid') {
      pushEvidenceValue(evidence, 'config field', contentHashFacts.configField);
      pushEvidenceValue(evidence, 'error', contentHashFacts.errorMessage);
    } else {
      pushEvidenceValue(evidence, 'baseline tag', contentHashFacts.baselineTag);
      pushEvidenceValue(
        evidence,
        'baseline version',
        contentHashFacts.baselineVersion,
      );
      pushEvidenceValue(
        evidence,
        'local output',
        contentHashFacts.localOutputDirectory,
      );
      pushEvidenceValue(
        evidence,
        'local version',
        contentHashFacts.localVersion,
      );
      pushEvidenceValue(evidence, 'tarball', contentHashFacts.tarballUrl);
      pushEvidenceValue(evidence, 'integrity', contentHashFacts.integrity);
      evidence.push({
        label: 'content hash diffs',
        lines: contentHashFacts.diffs.map((diff) =>
          [
            `${diff.kind}: ${diff.relativePath}`,
            diff.localHash ? `local=${diff.localHash}` : undefined,
            diff.remoteHash ? `remote=${diff.remoteHash}` : undefined,
          ]
            .filter((value): value is string => value !== undefined)
            .join(' '),
        ),
      });

      for (const group of contentHashFacts.ignoredDiffGroups) {
        evidence.push({
          label: `ignored by ${group.ruleIdentity}`,
          lines: group.diffs.map(
            (diff) => `${diff.kind}: ${diff.relativePath}`,
          ),
        });
      }
    }
  }

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
    locations: options.locations ? [...options.locations] : [],
    packageManifestPath: options.packageManifestPath,
    packageName: options.packageName,
    presentation: options.presentation,
    reason: options.facts.kind,
    task: 'release:check',
  } as ReleaseFindingForCode<Code>;
}

export function createReleaseCheckIssueFromFinding(options: {
  readonly finding: ReleaseFinding;
  readonly rootDir: string;
}): CanonicalLiminaCheckIssue {
  const { finding } = options;

  return createTaskFailureIssue({
    code: finding.code,
    detailLines: [
      finding.presentation.sectionTitle,
      `  - ${finding.presentation.problemLines[0] ?? finding.presentation.summary}`,
      ...finding.presentation.problemLines.slice(1),
    ],
    domain: 'release',
    evidence: finding.evidence,
    external: finding.external,
    filePath: finding.filePath,
    fix: 'Inspect the release check report, rebuild the package output, or adjust release metadata before publishing.',
    fixSteps: [
      'Inspect the release check section shown in this issue.',
      'Rebuild the package output or adjust release metadata for the failing section.',
      'Rerun the release check before publishing.',
    ],
    locations: finding.locations,
    packageManifestPath: finding.packageManifestPath,
    packageName: finding.packageName,
    reason: finding.reason,
    rootDir: options.rootDir,
    summary: finding.presentation.summary,
    task: finding.task,
    title: finding.presentation.title,
    tool: 'release',
    verifyCommands: ['limina release check'],
  });
}

export function createReleaseCheckIssuesFromFindings(options: {
  readonly findings: readonly ReleaseFinding[];
  readonly rootDir: string;
}): CanonicalLiminaCheckIssue[] {
  return options.findings.map((finding) =>
    createReleaseCheckIssueFromFinding({
      finding,
      rootDir: options.rootDir,
    }),
  );
}

const RELEASE_FINDING_SECTION_ORDER: readonly ReleaseFindingSection[] = [
  'tarball',
  'output-manifest',
  'source-link',
  'source-private',
  'source-workspace',
  'registry-content',
  'packed-lint',
  'packed-manifest',
];

export function orderReleaseFindingsForPresentation(
  findings: readonly ReleaseFinding[],
): ReleaseFinding[] {
  return RELEASE_FINDING_SECTION_ORDER.flatMap((section) =>
    findings.filter((finding) => finding.presentation.section === section),
  );
}

export function formatReleaseFindings(options: {
  readonly findings: readonly ReleaseFinding[];
  readonly label: string;
  readonly outDir: string;
  readonly publishOrder?: readonly string[];
  readonly rootDir: string;
}): string {
  const lines = [
    `package release check failed for ${options.label}:`,
    `  output: ${toRelativePath(options.rootDir, options.outDir)}`,
  ];

  for (const section of RELEASE_FINDING_SECTION_ORDER) {
    const sectionFindings = options.findings.filter(
      (finding) => finding.presentation.section === section,
    );

    if (sectionFindings.length === 0) {
      continue;
    }

    lines.push('', sectionFindings[0]!.presentation.sectionTitle);

    for (const finding of sectionFindings) {
      const [firstLine = finding.presentation.summary, ...remainingLines] =
        finding.presentation.problemLines;
      lines.push(`  - ${firstLine}`, ...remainingLines);
    }
  }

  if ((options.publishOrder?.length ?? 0) > 1) {
    lines.push(
      '',
      `Suggested publish order: ${options.publishOrder!.join(' -> ')}`,
    );
  }

  return lines.join('\n');
}
