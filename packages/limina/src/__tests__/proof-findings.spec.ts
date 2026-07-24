import { describe, expect, it } from 'vitest';

import {
  getLiminaCheckIssueRuleMetadata,
  LIMINA_CHECK_ISSUE_CODES,
  listLiminaCheckIssueCodes,
} from '../check-reporting/codes';
import { formatCheckIssueHumanReport } from '../check-reporting/human';
import {
  createProofCheckIssueFromFinding,
  createProofFinding,
  PROOF_SEMANTIC_ISSUE_CODES,
  type ProofFinding,
  type ProofFindingForCode,
  type ProofSemanticIssueCode,
} from '../proof/findings';

const ANSI_ESCAPE = String.fromCodePoint(0x1b);
const ANSI_PATTERN = new RegExp(
  String.raw`${ANSI_ESCAPE}\[[\d:;<=>?]*[\u0020-\u002F]*[\u0040-\u007E]`,
  'gu',
);

function stripAnsi(value: string): string {
  return value.replaceAll(ANSI_PATTERN, '');
}

function commonFindingFields(title: string) {
  return {
    evidence: [
      {
        label: 'semantic evidence',
        value: title,
      },
    ],
    filePath: '/repo/packages/app/src/index.ts',
    hint: `${title} hint`,
    locations: [
      {
        filePath: '/repo/packages/app/src/index.ts',
        label: 'source',
      },
    ],
    packageManifestPath: '/repo/packages/app/package.json',
    packageName: '@example/app',
    presentation: {
      detailLines: [`${title}:`, '  display label: presentation-only'],
      title,
    },
    reason: `${title} reason`,
  };
}

const graphCoverage = {
  checkerEntryPath: '/repo/.limina/tsconfig.typescript.build.json',
  checkerName: 'typescript',
  checkerPreset: 'tsc',
  label: 'packages/app/tsconfig.lib.dts.json',
  projectPath: '/repo/packages/app/tsconfig.lib.dts.json',
  type: 'graph' as const,
};

type ProofFindingMatrix = {
  readonly [Code in ProofSemanticIssueCode]: ProofFindingForCode<Code>;
};

const findingByCode = {
  [LIMINA_CHECK_ISSUE_CODES.proofAllowlistInvalid]: createProofFinding({
    ...commonFindingFields('Invalid proof allowlist config'),
    code: LIMINA_CHECK_ISSUE_CODES.proofAllowlistInvalid,
    facts: {
      configuredPath: '/absolute/source.ts',
      field: 'proof.allowlist[0].file',
      kind: 'config-entry',
      repositoryRoot: '/repo',
      ruleIndex: 0,
      value: '/absolute/source.ts',
      violation: 'absolute-path',
    },
    scope: 'proof.allowlist[0].file',
  }),
  [LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid]: createProofFinding({
    ...commonFindingFields('Checker entry references a missing tsconfig'),
    checkerName: 'typescript',
    code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
    facts: {
      checkerName: 'typescript',
      configPath: '/repo/.limina/tsconfig.typescript.build.json',
      kind: 'checker-entry',
      violation: 'missing-config',
    },
  }),
  [LIMINA_CHECK_ISSUE_CODES.proofDefaultTsconfigInvalid]: createProofFinding({
    ...commonFindingFields(
      'Directory with multiple typecheck environments must use tsconfig.json as an aggregator',
    ),
    code: LIMINA_CHECK_ISSUE_CODES.proofDefaultTsconfigInvalid,
    facts: {
      defaultConfigPath: '/repo/packages/app/tsconfig.json',
      directoryPath: '/repo/packages/app',
      environmentConfigPaths: [
        '/repo/packages/app/tsconfig.browser.json',
        '/repo/packages/app/tsconfig.node.json',
      ],
      kind: 'environment-layout',
      violation: 'multiple-environments-not-aggregated',
    },
  }),
  [LIMINA_CHECK_ISSUE_CODES.proofDuplicateGraphCoverage]: createProofFinding({
    ...commonFindingFields('Duplicate checker graph coverage'),
    code: LIMINA_CHECK_ISSUE_CODES.proofDuplicateGraphCoverage,
    facts: {
      checkerNames: ['typescript'],
      checkerPreset: 'tsc',
      declarationProjectPaths: [
        '/repo/packages/app/tsconfig.lib.dts.json',
        '/repo/packages/app/tsconfig.test.dts.json',
      ],
      graphEntryPaths: ['/repo/.limina/tsconfig.typescript.build.json'],
      kind: 'multiple-declaration-projects',
      sourcePath: '/repo/packages/app/src/index.ts',
    },
  }),
  [LIMINA_CHECK_ISSUE_CODES.proofDuplicateSourceOwner]: createProofFinding({
    ...commonFindingFields('Source file belongs to multiple typecheck configs'),
    code: LIMINA_CHECK_ISSUE_CODES.proofDuplicateSourceOwner,
    facts: {
      checkerNames: ['typescript'],
      kind: 'multiple-typecheck-owners',
      ownerProjectPaths: [
        '/repo/packages/app/tsconfig.lib.json',
        '/repo/packages/app/tsconfig.test.json',
      ],
      sourcePath: '/repo/packages/app/src/index.ts',
    },
  }),
  [LIMINA_CHECK_ISSUE_CODES.proofSourceBoundaryMismatch]: createProofFinding({
    ...commonFindingFields(
      'Typecheck proof source boundary does not match tsconfig coverage',
    ),
    code: LIMINA_CHECK_ISSUE_CODES.proofSourceBoundaryMismatch,
    facts: {
      configuredSourceExcludes: [],
      configuredSourceIncludes: ['packages/app/src/**/*.ts'],
      kind: 'coverage-outside-source-boundary',
      repositoryRoot: '/repo',
      sources: [
        {
          coverage: [graphCoverage],
          packageManifestPath: '/repo/packages/app/package.json',
          packageName: '@example/app',
          packageRoot: '/repo/packages/app',
          sourcePath: '/repo/packages/app/tools/config.ts',
        },
      ],
    },
  }),
  [LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile]: createProofFinding({
    ...commonFindingFields('Source file is not covered by typecheck proof'),
    code: LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile,
    facts: {
      candidateCheckerNames: ['typescript'],
      candidateProjectPaths: ['/repo/packages/app/tsconfig.lib.dts.json'],
      configuredSourceExcludes: [],
      configuredSourceIncludes: ['...'],
      coverage: [],
      kind: 'no-checker-or-allowlist-coverage',
      sourcePath: '/repo/packages/app/src/index.ts',
    },
  }),
} satisfies ProofFindingMatrix;

function proofFindingEntries(): readonly [
  ProofSemanticIssueCode,
  ProofFinding,
][] {
  return Object.entries(findingByCode) as [
    ProofSemanticIssueCode,
    ProofFinding,
  ][];
}

describe('typed Proof findings', () => {
  it('covers every current proof:check semantic code exactly once', () => {
    const registryCodes = listLiminaCheckIssueCodes()
      .filter(
        (code) =>
          getLiminaCheckIssueRuleMetadata(code).task === 'proof:check' &&
          code !== LIMINA_CHECK_ISSUE_CODES.proofCheckFailed,
      )
      .sort();

    expect([...PROOF_SEMANTIC_ISSUE_CODES].sort()).toEqual(registryCodes);
    expect(Object.keys(findingByCode).sort()).toEqual(registryCodes);
  });

  it.each(proofFindingEntries())(
    'adapts %s without inferring code, task, location, hint, owner, or evidence',
    (code, finding) => {
      const issue = createProofCheckIssueFromFinding({
        finding,
        rootDir: '/repo',
      });

      expect(issue).toMatchObject({
        code,
        filePath: 'packages/app/src/index.ts',
        fix: finding.hint,
        packageManifestPath: 'packages/app/package.json',
        packageName: '@example/app',
        reason: finding.reason,
        task: 'proof:check',
        title: finding.presentation.title,
      });
      expect(issue.evidence).toEqual(finding.evidence);
      expect(issue.locations).toEqual([
        {
          filePath: 'packages/app/src/index.ts',
          label: 'source',
        },
      ]);
      expect(finding.facts).toBe(findingByCode[code].facts);
    },
  );

  it('keeps source, project, checker, owner, coverage, and allowlist facts typed', () => {
    expect(
      findingByCode[LIMINA_CHECK_ISSUE_CODES.proofAllowlistInvalid].facts,
    ).toMatchObject({
      configuredPath: '/absolute/source.ts',
      repositoryRoot: '/repo',
      ruleIndex: 0,
      violation: 'absolute-path',
    });
    expect(
      findingByCode[LIMINA_CHECK_ISSUE_CODES.proofDuplicateSourceOwner].facts,
    ).toMatchObject({
      checkerNames: ['typescript'],
      ownerProjectPaths: [
        '/repo/packages/app/tsconfig.lib.json',
        '/repo/packages/app/tsconfig.test.json',
      ],
      sourcePath: '/repo/packages/app/src/index.ts',
    });
    expect(
      findingByCode[LIMINA_CHECK_ISSUE_CODES.proofSourceBoundaryMismatch].facts
        .sources[0],
    ).toEqual({
      coverage: [graphCoverage],
      packageManifestPath: '/repo/packages/app/package.json',
      packageName: '@example/app',
      packageRoot: '/repo/packages/app',
      sourcePath: '/repo/packages/app/tools/config.ts',
    });
  });

  it.each([
    'uncovered duplicate owner default tsconfig allowlist checker',
    'Graph Source Workspace wording that names unrelated domains',
  ])('keeps producer-selected code with misleading title %s', (title) => {
    const finding =
      findingByCode[LIMINA_CHECK_ISSUE_CODES.proofDuplicateGraphCoverage];
    const issue = createProofCheckIssueFromFinding({
      finding: {
        ...finding,
        presentation: {
          ...finding.presentation,
          title,
        },
      },
      rootDir: '/repo',
    });

    expect(issue.code).toBe(
      LIMINA_CHECK_ISSUE_CODES.proofDuplicateGraphCoverage,
    );
    expect(issue.task).toBe('proof:check');
  });

  it('keeps structured locations when formatter field labels change', () => {
    const finding =
      findingByCode[LIMINA_CHECK_ISSUE_CODES.proofDuplicateSourceOwner];
    const changedFinding = {
      ...finding,
      locations: [
        { filePath: '/repo/packages/app/src/index.ts', label: 'source' },
        {
          filePath: '/repo/packages/app/tsconfig.lib.json',
          label: 'owner project',
        },
        {
          filePath: '/repo/packages/app/tsconfig.test.json',
          label: 'owner project',
        },
      ],
      presentation: {
        ...finding.presentation,
        detailLines: [
          'Neutral presentation:',
          '  renamed-file-label: /presentation/fake.ts',
          '  renamed-owner-label: /presentation/fake-owner.json',
        ],
      },
    } satisfies ProofFindingForCode<
      typeof LIMINA_CHECK_ISSUE_CODES.proofDuplicateSourceOwner
    >;
    const issue = createProofCheckIssueFromFinding({
      finding: changedFinding,
      rootDir: '/repo',
    });

    expect(issue).toMatchObject({
      code: LIMINA_CHECK_ISSUE_CODES.proofDuplicateSourceOwner,
      filePath: 'packages/app/src/index.ts',
      packageManifestPath: 'packages/app/package.json',
      packageName: '@example/app',
    });
    expect(issue.locations).toEqual([
      {
        filePath: 'packages/app/src/index.ts',
        label: 'source',
      },
      {
        filePath: 'packages/app/tsconfig.lib.json',
        label: 'owner project',
      },
      {
        filePath: 'packages/app/tsconfig.test.json',
        label: 'owner project',
      },
    ]);
    expect(changedFinding.facts).toMatchObject({
      checkerNames: ['typescript'],
      ownerProjectPaths: [
        '/repo/packages/app/tsconfig.lib.json',
        '/repo/packages/app/tsconfig.test.json',
      ],
      sourcePath: '/repo/packages/app/src/index.ts',
    });
  });

  it('keeps a finding hint when its title and detail labels change', () => {
    const finding =
      findingByCode[LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile];
    const issue = createProofCheckIssueFromFinding({
      finding: {
        ...finding,
        presentation: {
          detailLines: ['Changed layout with no path-shaped labels.'],
          title: 'Completely changed human title',
        },
      },
      rootDir: '/repo',
    });

    expect(issue.fix).toBe(finding.hint);
    expect(issue.code).toBe(LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile);
    expect(issue.filePath).toBe('packages/app/src/index.ts');
  });

  it('isolates evidence and hints for findings with identical human text', () => {
    const base =
      findingByCode[LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile];
    const presentation = {
      detailLines: ['Identical rendered problem.'],
      title: 'Identical rendered problem',
    };
    const findings: ProofFinding[] = [
      {
        ...base,
        evidence: [{ label: 'first evidence', value: 'first' }],
        filePath: '/repo/packages/app/src/first.ts',
        hint: 'first hint',
        locations: [{ filePath: '/repo/packages/app/src/first.ts' }],
        presentation,
      },
      {
        ...base,
        evidence: [{ label: 'second evidence', value: 'second' }],
        filePath: '/repo/packages/app/src/second.ts',
        hint: 'second hint',
        locations: [{ filePath: '/repo/packages/app/src/second.ts' }],
        presentation,
      },
    ];
    const issues = findings.map((finding) =>
      createProofCheckIssueFromFinding({ finding, rootDir: '/repo' }),
    );

    expect(issues.map((issue) => issue.fix)).toEqual([
      'first hint',
      'second hint',
    ]);
    expect(issues.map((issue) => issue.evidence)).toEqual([
      [{ label: 'first evidence', value: 'first' }],
      [{ label: 'second evidence', value: 'second' }],
    ]);
    expect(issues.map((issue) => issue.filePath)).toEqual([
      'packages/app/src/first.ts',
      'packages/app/src/second.ts',
    ]);
  });

  it('excludes Graph, Source, and Workspace codes from Proof findings', () => {
    // @ts-expect-error Graph codes cannot enter Proof findings.
    const graphCode: ProofSemanticIssueCode =
      LIMINA_CHECK_ISSUE_CODES.graphReferenceMissing;
    // @ts-expect-error Source codes cannot enter Proof findings.
    const sourceCode: ProofSemanticIssueCode =
      LIMINA_CHECK_ISSUE_CODES.sourceOwnerInvalid;
    // @ts-expect-error Workspace codes cannot enter Proof findings.
    const workspaceCode: ProofSemanticIssueCode =
      LIMINA_CHECK_ISSUE_CODES.workspaceRegionOverlap;

    expect([graphCode, sourceCode, workspaceCode]).toEqual([
      LIMINA_CHECK_ISSUE_CODES.graphReferenceMissing,
      LIMINA_CHECK_ISSUE_CODES.sourceOwnerInvalid,
      LIMINA_CHECK_ISSUE_CODES.workspaceRegionOverlap,
    ]);
  });

  it('still rejects a runtime code/task mismatch through the canonical writer', () => {
    const finding =
      findingByCode[LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid];

    expect(() =>
      createProofCheckIssueFromFinding({
        finding: {
          ...finding,
          task: 'graph:check',
        } as unknown as ProofFinding,
        rootDir: '/repo',
      }),
    ).toThrow(
      'Issue code LIMINA_PROOF_CHECKER_COVERAGE_INVALID belongs to proof:check, not graph:check.',
    );
  });

  it('keeps the compact Proof human report contract for typed findings', () => {
    const finding =
      findingByCode[LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile];
    const issue = createProofCheckIssueFromFinding({
      finding,
      rootDir: '/repo',
    });
    const report = stripAnsi(
      formatCheckIssueHumanReport({
        color: true,
        command: 'limina proof check',
        issues: [issue],
        title: 'Proof check summary',
      }),
    );

    expect(report).toContain(
      'Source file is not covered by typecheck proof  1 issue',
    );
    expect(report).toContain(
      `rule: ${LIMINA_CHECK_ISSUE_CODES.proofUncoveredSourceFile}`,
    );
    expect(report).toContain('packages/app/package.json');
    expect(report).toContain(finding.hint);
  });
});
