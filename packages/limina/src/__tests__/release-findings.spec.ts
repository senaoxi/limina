import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  getLiminaCheckIssueRuleMetadata,
  LIMINA_CHECK_ISSUE_CODES,
  listLiminaCheckIssueCodes,
} from '../check-reporting/codes';
import { LIMINA_CHECK_ISSUE_DETECTOR_COVERAGE } from '../check-reporting/detector-coverage';
import { PackageReleaseConsistencyError } from '../package-check/release-consistency';
import {
  createReleaseCheckIssueFromFinding,
  createReleaseFinding,
  formatReleaseFindings,
  RELEASE_SEMANTIC_ISSUE_CODES,
  type ReleaseFinding,
  type ReleaseFindingForCode,
  type ReleaseSemanticIssueCode,
} from '../package-check/release-findings';

const ROOT_DIR = '/repo';
const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '../../../..');

function presentation(
  section: 'packed-manifest' | 'registry-content' | 'tarball',
) {
  return {
    problemLines: [
      '@example/app: deliberately misleading registry tarball content hash manifest wording',
    ],
    section,
    sectionTitle: 'Display-only section title:',
    summary: 'Display-only summary',
    title: 'Display-only title',
  } as const;
}

function commonFindingFields(
  section: 'packed-manifest' | 'registry-content' | 'tarball',
) {
  return {
    filePath: '/repo/packages/app/dist/package.json',
    packageManifestPath: '/repo/packages/app/package.json',
    packageName: '@example/app',
    presentation: presentation(section),
  };
}

type ReleaseFindingMatrix = {
  readonly [Code in ReleaseSemanticIssueCode]: ReleaseFindingForCode<Code>;
};

const findingByCode = {
  [LIMINA_CHECK_ISSUE_CODES.releaseContentHash]: createReleaseFinding({
    ...commonFindingFields('registry-content'),
    code: LIMINA_CHECK_ISSUE_CODES.releaseContentHash,
    facts: {
      baselineTag: 'latest',
      baselineVersion: '1.0.0',
      dependencyName: '@example/lib',
      diffs: [
        {
          kind: 'changed',
          localHash: 'local-changed',
          relativePath: 'index.js',
          remoteHash: 'remote-changed',
        },
        {
          kind: 'local-only',
          localHash: 'local-only',
          relativePath: 'local.js',
        },
        {
          kind: 'remote-only',
          relativePath: 'remote.js',
          remoteHash: 'remote-only',
        },
      ],
      ignoredDiffGroups: [
        {
          diffs: [
            {
              kind: 'changed',
              localHash: 'ignored-local',
              relativePath: 'README.md',
              remoteHash: 'ignored-remote',
            },
          ],
          ruleIdentity: 'builtin',
        },
      ],
      importerName: '@example/app',
      integrity: 'sha512-expected',
      integritySource: 'integrity',
      kind: 'content-diff',
      localOutputDirectory: '/repo/packages/lib/dist',
      localVersion: '1.1.0',
      sourceManifestPath: '/repo/packages/lib/package.json',
      tarballUrl: 'https://registry.npmjs.org/lib/-/lib-1.0.0.tgz',
    },
  }),
  [LIMINA_CHECK_ISSUE_CODES.releasePackedManifest]: createReleaseFinding({
    ...commonFindingFields('packed-manifest'),
    code: LIMINA_CHECK_ISSUE_CODES.releasePackedManifest,
    external: {
      code: 'no-file-dependencies',
      message: 'External display message.',
      tool: 'npm-package-json-lint',
    },
    facts: {
      dependencyName: '@example/lib',
      importerName: '@example/app',
      kind: 'packed-local-specifier',
      packedManifestPath: 'package.tgz#package.json',
      sectionName: 'devDependencies',
      specifier: 'file:../lib',
    },
  }),
  [LIMINA_CHECK_ISSUE_CODES.releaseRegistry]: createReleaseFinding({
    ...commonFindingFields('registry-content'),
    code: LIMINA_CHECK_ISSUE_CODES.releaseRegistry,
    facts: {
      dependencyName: '@example/lib',
      importerName: '@example/app',
      kind: 'metadata-http-status',
      registryUrl: 'https://registry.npmjs.org/%40example%2Flib',
      requestedDistTag: 'latest',
      statusCode: 503,
      statusText: 'Service Unavailable',
      timeoutMs: 30_000,
    },
  }),
  [LIMINA_CHECK_ISSUE_CODES.releaseTarballHygiene]: createReleaseFinding({
    ...commonFindingFields('tarball'),
    code: LIMINA_CHECK_ISSUE_CODES.releaseTarballHygiene,
    facts: {
      archiveEntryPath: 'dist/index.js.map',
      kind: 'source-map-file',
      tarballPath: 'example-app-1.0.0.tgz',
    },
  }),
} satisfies ReleaseFindingMatrix;

function releaseFindingEntries(): readonly [
  ReleaseSemanticIssueCode,
  ReleaseFinding,
][] {
  return Object.entries(findingByCode) as [
    ReleaseSemanticIssueCode,
    ReleaseFinding,
  ][];
}

describe('typed Release findings', () => {
  it('covers every currently produced release:check semantic code exactly once', () => {
    const registryCodes = listLiminaCheckIssueCodes()
      .filter(
        (code) =>
          getLiminaCheckIssueRuleMetadata(code).task === 'release:check' &&
          code !== LIMINA_CHECK_ISSUE_CODES.releaseCheckFailed &&
          code !== LIMINA_CHECK_ISSUE_CODES.releaseConsistency,
      )
      .sort();

    expect([...RELEASE_SEMANTIC_ISSUE_CODES].sort()).toEqual(registryCodes);
    expect(Object.keys(findingByCode).sort()).toEqual(registryCodes);
    expect(
      LIMINA_CHECK_ISSUE_DETECTOR_COVERAGE[
        LIMINA_CHECK_ISSUE_CODES.releaseConsistency
      ],
    ).toMatchObject({ kind: 'planned', task: 'release:check' });
  });

  it.each(releaseFindingEntries())(
    'adapts %s without inferring code, task, package, path, evidence, or external metadata',
    (code, finding) => {
      const issue = createReleaseCheckIssueFromFinding({
        finding,
        rootDir: ROOT_DIR,
      });

      expect(issue).toMatchObject({
        code,
        filePath: 'packages/app/dist/package.json',
        packageManifestPath: 'packages/app/package.json',
        packageName: '@example/app',
        reason: finding.reason,
        task: 'release:check',
        title: 'Display-only title',
      });
      expect(issue.evidence).toEqual(finding.evidence);
      expect(issue.external).toEqual(finding.external);
      expect(finding.facts).toBe(findingByCode[code].facts);
    },
  );

  it('keeps manifest, tarball, registry, integrity, status, and content hash facts typed', () => {
    expect(
      findingByCode[LIMINA_CHECK_ISSUE_CODES.releasePackedManifest].facts,
    ).toMatchObject({
      dependencyName: '@example/lib',
      packedManifestPath: 'package.tgz#package.json',
      sectionName: 'devDependencies',
      specifier: 'file:../lib',
    });
    expect(
      findingByCode[LIMINA_CHECK_ISSUE_CODES.releaseTarballHygiene].facts,
    ).toMatchObject({
      archiveEntryPath: 'dist/index.js.map',
      tarballPath: 'example-app-1.0.0.tgz',
    });
    expect(
      findingByCode[LIMINA_CHECK_ISSUE_CODES.releaseRegistry].facts,
    ).toMatchObject({
      registryUrl: 'https://registry.npmjs.org/%40example%2Flib',
      statusCode: 503,
      statusText: 'Service Unavailable',
    });
    expect(
      findingByCode[LIMINA_CHECK_ISSUE_CODES.releaseContentHash].facts,
    ).toMatchObject({
      integrity: 'sha512-expected',
      integritySource: 'integrity',
    });
    const contentHashFacts =
      findingByCode[LIMINA_CHECK_ISSUE_CODES.releaseContentHash].facts;

    if (contentHashFacts.kind !== 'content-diff') {
      throw new Error('expected content-diff facts');
    }

    expect(contentHashFacts.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'changed',
          localHash: 'local-changed',
          remoteHash: 'remote-changed',
        }),
        expect.objectContaining({ kind: 'local-only' }),
        expect.objectContaining({ kind: 'remote-only' }),
      ]),
    );
  });

  it('keeps raw and computed registry integrity and shasum facts in evidence', () => {
    const finding = createReleaseFinding({
      ...commonFindingFields('registry-content'),
      code: LIMINA_CHECK_ISSUE_CODES.releaseRegistry,
      facts: {
        actualIntegrity: 'sha512-actual',
        actualShasum: 'actual-shasum',
        dependencyName: '@example/lib',
        expectedIntegrity: 'sha512-expected',
        expectedShasum: 'expected-shasum',
        importerName: '@example/app',
        integritySource: 'shasum',
        kind: 'integrity-mismatch',
        registryShasum: 'expected-shasum',
        registryUrl: 'https://registry.npmjs.org/%40example%2Flib',
        requestedVersion: '1.0.0',
        tarballUrl: 'https://registry.npmjs.org/lib/-/lib-1.0.0.tgz',
      },
    });

    expect(finding.facts).toMatchObject({
      actualIntegrity: 'sha512-actual',
      actualShasum: 'actual-shasum',
      expectedIntegrity: 'sha512-expected',
      expectedShasum: 'expected-shasum',
      registryShasum: 'expected-shasum',
    });
    expect(finding.evidence).toEqual(
      expect.arrayContaining([
        { label: 'expected integrity', value: 'sha512-expected' },
        { label: 'expected shasum', value: 'expected-shasum' },
        { label: 'actual integrity', value: 'sha512-actual' },
        { label: 'actual shasum', value: 'actual-shasum' },
        { label: 'registry shasum', value: 'expected-shasum' },
      ]),
    );
  });

  it.each([
    'contentHash registry tarball',
    'content hash changed local-only remote-only',
    'manifest integrity shasum registry',
  ])('keeps producer-selected code when display text says %s', (text) => {
    const finding = findingByCode[LIMINA_CHECK_ISSUE_CODES.releaseContentHash];
    const issue = createReleaseCheckIssueFromFinding({
      finding: {
        ...finding,
        presentation: {
          ...finding.presentation,
          problemLines: [text],
          sectionTitle: `${text}:`,
          summary: text,
          title: text,
        },
      },
      rootDir: ROOT_DIR,
    });

    expect(issue.code).toBe(LIMINA_CHECK_ISSUE_CODES.releaseContentHash);
    expect(issue.task).toBe('release:check');
    expect(finding.facts.kind).toBe('content-diff');
  });

  it('keeps structured fields when formatter labels change', () => {
    const finding = findingByCode[LIMINA_CHECK_ISSUE_CODES.releaseRegistry];
    const issue = createReleaseCheckIssueFromFinding({
      finding: {
        ...finding,
        presentation: {
          ...finding.presentation,
          problemLines: [
            'renamed-package: @presentation/fake',
            'renamed-manifest: /presentation/fake.json',
            'renamed-registry: https://presentation.invalid',
          ],
        },
      },
      rootDir: ROOT_DIR,
    });

    expect(issue).toMatchObject({
      code: LIMINA_CHECK_ISSUE_CODES.releaseRegistry,
      filePath: 'packages/app/dist/package.json',
      packageManifestPath: 'packages/app/package.json',
      packageName: '@example/app',
      reason: 'metadata-http-status',
      task: 'release:check',
    });
    expect(finding.facts.registryUrl).toBe(
      'https://registry.npmjs.org/%40example%2Flib',
    );
  });

  it('keeps rendered section strings out of evidence, location, reason, and identity', () => {
    const finding = findingByCode[LIMINA_CHECK_ISSUE_CODES.releaseRegistry];
    const originalIssue = createReleaseCheckIssueFromFinding({
      finding,
      rootDir: ROOT_DIR,
    });
    const changedIssue = createReleaseCheckIssueFromFinding({
      finding: {
        ...finding,
        presentation: {
          ...finding.presentation,
          problemLines: ['Completely different rendered section body.'],
          sectionTitle: 'Completely different rendered section title:',
        },
      },
      rootDir: ROOT_DIR,
    });

    expect(changedIssue.detailLines).not.toEqual(originalIssue.detailLines);
    expect(changedIssue).toMatchObject({
      code: originalIssue.code,
      evidence: originalIssue.evidence,
      id: originalIssue.id,
      locations: originalIssue.locations,
      reason: originalIssue.reason,
      task: originalIssue.task,
    });
  });

  it('keeps typed findings authoritative when Error.message changes', () => {
    const findings = releaseFindingEntries().map(([, finding]) => finding);
    const error = new PackageReleaseConsistencyError(findings, {
      label: '@example/app',
      outDir: '/repo/packages/app/dist',
      rootDir: ROOT_DIR,
    });
    const issuesBeforeMessageChange = error.findings.map((finding) =>
      createReleaseCheckIssueFromFinding({ finding, rootDir: ROOT_DIR }),
    );

    expect(error.message).toContain('package release check failed');
    expect(error.findings.map((finding) => finding.code)).toEqual([
      LIMINA_CHECK_ISSUE_CODES.releaseTarballHygiene,
      LIMINA_CHECK_ISSUE_CODES.releaseContentHash,
      LIMINA_CHECK_ISSUE_CODES.releaseRegistry,
      LIMINA_CHECK_ISSUE_CODES.releasePackedManifest,
    ]);
    error.message = 'registry tarball contentHash formatter text changed';

    const issuesAfterMessageChange = error.findings.map((finding) =>
      createReleaseCheckIssueFromFinding({ finding, rootDir: ROOT_DIR }),
    );

    expect(issuesAfterMessageChange).toEqual(issuesBeforeMessageChange);
    expect(issuesAfterMessageChange).toEqual(
      expect.arrayContaining(
        RELEASE_SEMANTIC_ISSUE_CODES.map((code) =>
          expect.objectContaining({ code, task: 'release:check' }),
        ),
      ),
    );
  });

  it('formats typed findings without feeding rendered sections back into semantics', () => {
    const findings = releaseFindingEntries().map(([, finding]) => finding);
    const output = formatReleaseFindings({
      findings,
      label: '@example/app',
      outDir: '/repo/packages/app/dist',
      publishOrder: ['@example/lib', '@example/app'],
      rootDir: ROOT_DIR,
    });

    expect(output).toContain('package release check failed for @example/app:');
    expect(output).toContain('Display-only section title:');
    expect(output).toContain(
      'Suggested publish order: @example/lib -> @example/app',
    );
    expect(findings.map((finding) => finding.code)).toEqual(
      releaseFindingEntries().map(([code]) => code),
    );
  });

  it('keeps identical display text findings independent by evidence and location', () => {
    const left = findingByCode[LIMINA_CHECK_ISSUE_CODES.releaseRegistry];
    const right = createReleaseFinding({
      ...commonFindingFields('registry-content'),
      code: LIMINA_CHECK_ISSUE_CODES.releaseRegistry,
      facts: {
        ...left.facts,
        dependencyName: '@example/other',
      },
      filePath: '/repo/packages/other/package.json',
      packageManifestPath: '/repo/packages/other/package.json',
      packageName: '@example/other',
    });
    const leftIssue = createReleaseCheckIssueFromFinding({
      finding: left,
      rootDir: ROOT_DIR,
    });
    const rightIssue = createReleaseCheckIssueFromFinding({
      finding: right,
      rootDir: ROOT_DIR,
    });

    expect(left.presentation).toEqual(right.presentation);
    expect(left.evidence).not.toBe(right.evidence);
    expect(leftIssue.id).not.toBe(rightIssue.id);
    expect(leftIssue.filePath).toBe('packages/app/dist/package.json');
    expect(rightIssue.filePath).toBe('packages/other/package.json');
  });

  it('still rejects a runtime code/task mismatch through the canonical writer', () => {
    const finding = findingByCode[LIMINA_CHECK_ISSUE_CODES.releaseRegistry];

    expect(() =>
      createReleaseCheckIssueFromFinding({
        finding: {
          ...finding,
          task: 'package:check',
        } as unknown as ReleaseFinding,
        rootDir: ROOT_DIR,
      }),
    ).toThrow(
      'Issue code LIMINA_RELEASE_REGISTRY belongs to release:check, not package:check.',
    );
  });

  it('keeps Release finding codes limited to the Release semantic union', () => {
    // @ts-expect-error Package codes cannot be assigned to Release findings.
    const invalidPackageCode: ReleaseSemanticIssueCode =
      LIMINA_CHECK_ISSUE_CODES.packageBoundary;
    // @ts-expect-error Graph codes cannot be assigned to Release findings.
    const invalidGraphCode: ReleaseSemanticIssueCode =
      LIMINA_CHECK_ISSUE_CODES.graphReferenceMissing;
    // @ts-expect-error Source codes cannot be assigned to Release findings.
    const invalidSourceCode: ReleaseSemanticIssueCode =
      LIMINA_CHECK_ISSUE_CODES.sourcePackageImportInvalid;
    // @ts-expect-error Proof codes cannot be assigned to Release findings.
    const invalidProofCode: ReleaseSemanticIssueCode =
      LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile;
    // @ts-expect-error Workspace codes cannot be assigned to Release findings.
    const invalidWorkspaceCode: ReleaseSemanticIssueCode =
      LIMINA_CHECK_ISSUE_CODES.workspaceRegionOverlap;

    for (const code of [
      invalidPackageCode,
      invalidGraphCode,
      invalidSourceCode,
      invalidProofCode,
      invalidWorkspaceCode,
    ]) {
      expect(RELEASE_SEMANTIC_ISSUE_CODES.includes(code)).toBe(false);
    }
  });

  it('removes Release section, body, regex, and Error.message classification', () => {
    const source = readFileSync(
      path.join(WORKSPACE_ROOT, 'packages/limina/src/commands/release.ts'),
      'utf8',
    );

    expect(source).not.toContain('getReleaseConsistencySectionCode');
    expect(source).not.toContain('formatErrorMessage(options.error)');
    expect(source).not.toContain("section.includes('tarball')");
    expect(source).not.toContain("section.includes('registry')");
    expect(source).not.toContain(
      '/content hash|local-only|remote-only|changed/iu',
    );
    expect(source).toContain('options.error.findings');
  });
});
