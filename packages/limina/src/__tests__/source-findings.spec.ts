import type { ResolvedLiminaConfig } from '#config/runner';
import { describe, expect, it } from 'vitest';

import {
  getLiminaCheckIssueRuleMetadata,
  LIMINA_CHECK_ISSUE_CODES,
  listLiminaCheckIssueCodes,
} from '../check-reporting/codes';
import {
  createSourceCheckIssueFromFinding,
  createSourceUnusedModuleFinding,
  createSourceUnusedWorkspaceDependencyFinding,
  SOURCE_SEMANTIC_ISSUE_CODES,
  type SourceFinding,
  type SourceFindingForCode,
  type SourceSemanticIssueCode,
} from '../source-check/findings';
import { formatSourceCheckHumanReport } from '../source-check/report';

const config = {
  configPath: '/repo/limina.config.mts',
  rootDir: '/repo',
} as ResolvedLiminaConfig;

function commonFindingFields(title: string) {
  return {
    checkerName: 'source-contract',
    detector: 'source',
    evidence: [
      {
        label: 'diagnostic',
        lines: [`${title}:`, '  presentation label: display-only'],
      },
    ],
    filePath: '/repo/packages/app/src/index.ts',
    locations: [
      {
        filePath: '/repo/packages/app/src/index.ts',
        label: 'file',
      },
    ],
    ownerName: '@example/app',
    packageJsonPath: '/repo/packages/app/package.json',
    reason: `${title} reason`,
    summary: title,
    task: 'source:check' as const,
    title,
    tool: 'limina',
    verifyCommands: ['limina source check'],
  };
}

type SourceFindingMatrix = {
  readonly [Code in SourceSemanticIssueCode]: SourceFindingForCode<Code>;
};

const findingByCode = {
  [LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationConfigInvalid]: {
    ...commonFindingFields('Ambient declaration rule is invalid'),
    code: LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationConfigInvalid,
    facts: {
      include: ['types/**/*.d.ts'],
      kind: 'no-matches',
      ruleIdentity: 'types/**/*.d.ts',
      ruleIndex: 0,
    },
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationSharedUnauthorized]: {
    ...commonFindingFields('Shared declaration is not authorized'),
    code: LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationSharedUnauthorized,
    facts: {
      consumers: [
        {
          configPaths: ['/repo/packages/app/tsconfig.json'],
          packageManifestPath: '/repo/packages/app/package.json',
          packageName: '@example/app',
        },
      ],
      declarationPath: '/repo/types/global.d.ts',
      kind: 'shared-across-owners',
      ruleIdentity: 'types/**/*.d.ts',
      ruleIndex: 0,
    },
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationReferenceUnauthorized]: {
    ...commonFindingFields('Declaration reference is not authorized'),
    code: LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationReferenceUnauthorized,
    facts: {
      declarationPath: '/repo/types/global.d.ts',
      importerPath: '/repo/packages/app/src/index.ts',
      kind: 'triple-slash-path-reference',
      line: 1,
      packageManifestPath: '/repo/packages/app/package.json',
      packageName: '@example/app',
      referenceKind: 'path',
      ruleIdentity: 'types/**/*.d.ts',
      ruleIndex: 0,
    },
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceCrossGovernanceBoundary]: {
    ...commonFindingFields('Source import crosses a governance boundary'),
    code: LIMINA_CHECK_ISSUE_CODES.sourceCrossGovernanceBoundary,
    facts: {
      boundary: {
        configPath: '/repo/nested/limina.config.mts',
        kind: 'nested-config-root',
        rootDir: '/repo/nested',
      },
      importerPath: '/repo/packages/app/src/index.ts',
      kind: 'cross-governance-boundary',
      line: 2,
      packageManifestPath: '/repo/packages/app/package.json',
      packageName: '@example/app',
      resolvedTargetPath: '/repo/nested/src/index.ts',
      specifier: '../../../nested/src/index',
    },
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceImportAuthorityInvalid]: {
    ...commonFindingFields('Import authority grant is invalid'),
    code: LIMINA_CHECK_ISSUE_CODES.sourceImportAuthorityInvalid,
    facts: {
      field: 'source.importAuthority.allow["@example/app"]',
      grantIndex: 0,
      kind: 'grant',
      ownerIdentity: '@example/app',
      packageManifestPath: '/repo/packages/app/package.json',
      suggestion: 'Add a reason.',
    },
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceKnipBuildScriptUnsupported]: {
    ...commonFindingFields('Unsupported source usage command'),
    code: LIMINA_CHECK_ISSUE_CODES.sourceKnipBuildScriptUnsupported,
    external: { tool: 'knip' },
    facts: {
      command: 'limina build $CONFIG',
      kind: 'unsupported-build-script',
      packageManifestPath: '/repo/packages/app/package.json',
      packageName: '@example/app',
      scriptName: 'build',
    },
    tool: 'knip',
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceKnipConfigInvalid]: {
    ...commonFindingFields('Source usage workspace config is invalid'),
    code: LIMINA_CHECK_ISSUE_CODES.sourceKnipConfigInvalid,
    external: { tool: 'knip' },
    facts: {
      field: 'source.knip.workspaces["@example/app"].entry',
      kind: 'entry',
      packageName: '@example/app',
      value: [],
    },
    tool: 'knip',
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceOwnerInvalid]: {
    ...commonFindingFields('Source ownership is invalid'),
    code: LIMINA_CHECK_ISSUE_CODES.sourceOwnerInvalid,
    facts: {
      configPath: '/repo/packages/app/tsconfig.json',
      filePaths: ['/repo/packages/app/src/index.ts'],
      kind: 'missing-owner',
      role: 'typecheck companion',
    },
  },
  [LIMINA_CHECK_ISSUE_CODES.sourcePackageImportInvalid]: {
    ...commonFindingFields('Package import target is invalid'),
    code: LIMINA_CHECK_ISSUE_CODES.sourcePackageImportInvalid,
    facts: {
      importerPath: '/repo/packages/app/src/index.ts',
      kind: 'other-owner-target',
      line: 4,
      packageManifestPath: '/repo/packages/app/package.json',
      packageName: '@example/app',
      resolvedTargetPath: '/repo/packages/lib/src/internal.ts',
      specifier: '@example/lib/internal',
      targetPackageManifestPath: '/repo/packages/lib/package.json',
      targetPackageName: '@example/lib',
    },
  },
  [LIMINA_CHECK_ISSUE_CODES.sourcePackageImportUnauthorized]: {
    ...commonFindingFields('Bare package import is unauthorized'),
    code: LIMINA_CHECK_ISSUE_CODES.sourcePackageImportUnauthorized,
    facts: {
      authorityManifestPaths: ['/repo/packages/app/package.json'],
      dependencyName: 'zod',
      importerPath: '/repo/packages/app/src/index.ts',
      kind: 'bare-package-import',
      line: 5,
      ownerIdentity: '@example/app',
      packageManifestPath: '/repo/packages/app/package.json',
      packageName: '@example/app',
      specifier: 'zod',
    },
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceRelativeImportEscapesScope]: {
    ...commonFindingFields('Relative import escapes source scope'),
    code: LIMINA_CHECK_ISSUE_CODES.sourceRelativeImportEscapesScope,
    facts: {
      importerPath: '/repo/packages/app/src/index.ts',
      kind: 'relative-import',
      line: 6,
      packageManifestPath: '/repo/packages/app/package.json',
      packageName: '@example/app',
      packageScopeManifestPath: '/repo/packages/app/package.json',
      resolvedTargetPath: '/repo/packages/lib/src/index.ts',
      specifier: '../../lib/src/index',
      targetPackageManifestPath: '/repo/packages/lib/package.json',
    },
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceResourceModuleNotFound]: {
    ...commonFindingFields('Resource module was not found'),
    code: LIMINA_CHECK_ISSUE_CODES.sourceResourceModuleNotFound,
    facts: {
      checkedPath: '/repo/packages/app/src/missing.css',
      checkerName: 'source-contract',
      configPath: '/repo/packages/app/tsconfig.dts.json',
      importerPath: '/repo/packages/app/src/index.ts',
      kind: 'resource-module-not-found',
      line: 7,
      specifier: './missing.css',
      typeEvidenceKind: 'ambient',
    },
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceResourceModuleTypeUndeclared]: {
    ...commonFindingFields('Resource module type is undeclared'),
    code: LIMINA_CHECK_ISSUE_CODES.sourceResourceModuleTypeUndeclared,
    facts: {
      checkerName: 'source-contract',
      configPath: '/repo/packages/app/tsconfig.dts.json',
      importerPath: '/repo/packages/app/src/index.ts',
      kind: 'resource-module-type-undeclared',
      line: 8,
      runtimeAuthority: 'filesystem',
      runtimeFilePath: '/repo/packages/app/src/style.css',
      specifier: './style.css',
      typeEvidenceKind: 'missing',
    },
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance]: {
    ...commonFindingFields('Project ownership route is invalid'),
    code: LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance,
    facts: {
      checkerName: 'source graph routes',
      configPath: '/repo/packages/app/tsconfig.json',
      kind: 'checker-route',
    },
  },
  [LIMINA_CHECK_ISSUE_CODES.sourceUnusedModule]:
    createSourceUnusedModuleFinding({
      externalCode: 'files',
      externalMessage: 'Unused file reported by Knip.',
      filePath: '/repo/packages/app/src/dead.ts',
      ownerDirectory: '/repo/packages/app',
      ownerName: '@example/app',
      packageJsonPath: '/repo/packages/app/package.json',
    }),
  [LIMINA_CHECK_ISSUE_CODES.sourceUnusedWorkspaceDependency]:
    createSourceUnusedWorkspaceDependencyFinding({
      dependencyName: '@example/lib',
      externalCode: 'dependencies',
      externalMessage: 'Unused dependency reported by Knip.',
      ownerName: '@example/app',
      packageJsonPath: '/repo/packages/app/package.json',
      sectionName: 'dependencies',
      specifier: 'workspace:*',
    }),
} satisfies SourceFindingMatrix;

function sourceFindingEntries(): readonly [
  SourceSemanticIssueCode,
  SourceFinding,
][] {
  return Object.entries(findingByCode) as [
    SourceSemanticIssueCode,
    SourceFinding,
  ][];
}

describe('typed Source findings', () => {
  it('covers every current source:check semantic code exactly once', () => {
    const registryCodes = listLiminaCheckIssueCodes()
      .filter(
        (code) =>
          getLiminaCheckIssueRuleMetadata(code).task === 'source:check' &&
          code !== LIMINA_CHECK_ISSUE_CODES.sourceCheckFailed,
      )
      .sort();

    expect([...SOURCE_SEMANTIC_ISSUE_CODES].sort()).toEqual(registryCodes);
    expect(Object.keys(findingByCode).sort()).toEqual(registryCodes);
  });

  it.each(sourceFindingEntries())(
    'adapts %s without inferring code, task, location, owner, or evidence',
    (code, finding) => {
      const issue = createSourceCheckIssueFromFinding({
        finding,
        rootDir: config.rootDir,
      });

      expect(issue).toMatchObject({
        code,
        packageName: finding.ownerName,
        task: 'source:check',
        title: finding.title,
      });
      expect(issue.evidence).toEqual(
        finding.evidence.length > 0 ? finding.evidence : undefined,
      );
      expect(finding.facts).toBe(findingByCode[code].facts);

      if (finding.checkerName) {
        expect(issue.checkerName).toBe(finding.checkerName);
      }

      if (finding.filePath) {
        expect(issue.filePath).toBe(finding.filePath.replace('/repo/', ''));
      }

      if (finding.packageJsonPath) {
        expect(issue.packageManifestPath).toBe(
          finding.packageJsonPath.replace('/repo/', ''),
        );
      }
    },
  );

  it('keeps source-specific rule, importer, target, dependency, and owner facts typed', () => {
    expect(
      findingByCode[
        LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationConfigInvalid
      ].facts,
    ).toMatchObject({
      ruleIdentity: 'types/**/*.d.ts',
      ruleIndex: 0,
    });
    expect(
      findingByCode[LIMINA_CHECK_ISSUE_CODES.sourcePackageImportInvalid].facts,
    ).toMatchObject({
      importerPath: '/repo/packages/app/src/index.ts',
      resolvedTargetPath: '/repo/packages/lib/src/internal.ts',
      targetPackageName: '@example/lib',
    });
    expect(
      findingByCode[LIMINA_CHECK_ISSUE_CODES.sourceUnusedWorkspaceDependency]
        .facts,
    ).toMatchObject({
      dependencyName: '@example/lib',
      packageManifestPath: '/repo/packages/app/package.json',
      packageName: '@example/app',
    });
  });

  it.each([
    'Knip says this is a different rule',
    'Tsconfig wording implies another rule',
    'Ambient declaration wording implies another rule',
  ])('keeps producer-selected code with misleading title %s', (title) => {
    const finding =
      findingByCode[LIMINA_CHECK_ISSUE_CODES.sourcePackageImportInvalid];
    const issue = createSourceCheckIssueFromFinding({
      finding: {
        ...finding,
        summary: title,
        title,
      },
      rootDir: config.rootDir,
    });

    expect(issue.code).toBe(
      LIMINA_CHECK_ISSUE_CODES.sourcePackageImportInvalid,
    );
    expect(issue.task).toBe('source:check');
  });

  it('keeps structured paths and ownership when display labels change', () => {
    const finding =
      findingByCode[LIMINA_CHECK_ISSUE_CODES.sourceRelativeImportEscapesScope];
    const issue = createSourceCheckIssueFromFinding({
      finding: {
        ...finding,
        evidence: [
          {
            label: 'renamed display section',
            lines: ['renamed-file-label: /presentation/only.ts'],
          },
        ],
        locations: [
          {
            filePath: finding.filePath,
            label: 'renamed location label',
          },
        ],
      },
      rootDir: config.rootDir,
    });

    expect(issue).toMatchObject({
      code: LIMINA_CHECK_ISSUE_CODES.sourceRelativeImportEscapesScope,
      filePath: 'packages/app/src/index.ts',
      packageManifestPath: 'packages/app/package.json',
      packageName: '@example/app',
      task: 'source:check',
    });
    expect(issue.locations).toEqual([
      expect.objectContaining({
        filePath: 'packages/app/src/index.ts',
        label: 'renamed location label',
      }),
    ]);
  });

  it('does not use a rendered problem as code or location identity', () => {
    const finding = findingByCode[LIMINA_CHECK_ISSUE_CODES.sourceOwnerInvalid];
    const issue = createSourceCheckIssueFromFinding({
      finding: {
        ...finding,
        evidence: [
          {
            label: 'diagnostic',
            lines: [
              'Knip Tsconfig Ambient declaration package import:',
              '  file: /presentation/fake.ts',
              '  package manifest: /presentation/package.json',
            ],
          },
        ],
      },
      rootDir: config.rootDir,
    });

    expect(issue).toMatchObject({
      code: LIMINA_CHECK_ISSUE_CODES.sourceOwnerInvalid,
      filePath: 'packages/app/src/index.ts',
      packageManifestPath: 'packages/app/package.json',
      packageName: '@example/app',
    });
  });

  it('keeps Knip external codes and ignores external message wording', () => {
    const first = createSourceUnusedModuleFinding({
      externalCode: 'files',
      externalMessage: 'First external wording.',
      filePath: '/repo/packages/app/src/dead.ts',
      ownerDirectory: '/repo/packages/app',
      ownerName: '@example/app',
      packageJsonPath: '/repo/packages/app/package.json',
    });
    const second = createSourceUnusedModuleFinding({
      externalCode: 'files',
      externalMessage:
        'Tsconfig dependency workspace region wording changed completely.',
      filePath: '/repo/packages/app/src/dead.ts',
      ownerDirectory: '/repo/packages/app',
      ownerName: '@example/app',
      packageJsonPath: '/repo/packages/app/package.json',
    });
    const issues = [first, second].map((finding) =>
      createSourceCheckIssueFromFinding({
        finding,
        rootDir: config.rootDir,
      }),
    );

    expect(issues.map(({ code, task }) => ({ code, task }))).toEqual([
      {
        code: LIMINA_CHECK_ISSUE_CODES.sourceUnusedModule,
        task: 'source:check',
      },
      {
        code: LIMINA_CHECK_ISSUE_CODES.sourceUnusedModule,
        task: 'source:check',
      },
    ]);
    expect(issues.map((issue) => issue.external?.code)).toEqual([
      'files',
      'files',
    ]);
  });

  it('keeps Knip config and build codes independent of rendered sections', () => {
    const configFinding =
      findingByCode[LIMINA_CHECK_ISSUE_CODES.sourceKnipConfigInvalid];
    const buildFinding =
      findingByCode[LIMINA_CHECK_ISSUE_CODES.sourceKnipBuildScriptUnsupported];
    const issues = [
      {
        ...configFinding,
        title: 'Neutral configuration title',
      },
      {
        ...buildFinding,
        evidence: [{ label: 'details', lines: ['neutral rendered section'] }],
        title: 'Neutral command title',
      },
    ].map((finding) =>
      createSourceCheckIssueFromFinding({
        finding,
        rootDir: config.rootDir,
      }),
    );

    expect(issues.map((issue) => issue.code)).toEqual([
      LIMINA_CHECK_ISSUE_CODES.sourceKnipConfigInvalid,
      LIMINA_CHECK_ISSUE_CODES.sourceKnipBuildScriptUnsupported,
    ]);
  });

  it('does not treat an external tool code as a canonical Limina code', () => {
    const finding = createSourceUnusedWorkspaceDependencyFinding({
      dependencyName: '@example/lib',
      externalCode: LIMINA_CHECK_ISSUE_CODES.workspaceRegionOverlap,
      ownerName: '@example/app',
      packageJsonPath: '/repo/packages/app/package.json',
      sectionName: 'dependencies',
      specifier: 'workspace:*',
    });
    const issue = createSourceCheckIssueFromFinding({
      finding,
      rootDir: config.rootDir,
    });

    expect(issue.code).toBe(
      LIMINA_CHECK_ISSUE_CODES.sourceUnusedWorkspaceDependency,
    );
    expect(issue.external?.code).toBe(
      LIMINA_CHECK_ISSUE_CODES.workspaceRegionOverlap,
    );
  });

  it('excludes workspace codes from the Source finding code union', () => {
    // @ts-expect-error Workspace validation codes cannot enter Source findings.
    const invalidCode: SourceSemanticIssueCode =
      LIMINA_CHECK_ISSUE_CODES.workspaceRegionOverlap;

    expect(invalidCode).toBe(LIMINA_CHECK_ISSUE_CODES.workspaceRegionOverlap);
  });

  it('still rejects a runtime code/task mismatch through the canonical writer', () => {
    const finding =
      findingByCode[LIMINA_CHECK_ISSUE_CODES.sourcePackageImportUnauthorized];

    expect(() =>
      createSourceCheckIssueFromFinding({
        finding: {
          ...finding,
          task: 'workspace:validate',
        } as unknown as SourceFinding,
        rootDir: config.rootDir,
      }),
    ).toThrow(
      'Issue code LIMINA_SOURCE_PACKAGE_IMPORT_UNAUTHORIZED belongs to source:check, not workspace:validate.',
    );
  });

  it('keeps the compact Source human report contract for typed findings', () => {
    const finding =
      findingByCode[LIMINA_CHECK_ISSUE_CODES.sourcePackageImportUnauthorized];
    const report = formatSourceCheckHumanReport({
      config,
      issues: [finding],
      report: { command: 'limina source check' },
    });

    expect(report).toContain('Bare package import is unauthorized  1 issue');
    expect(report).toContain(
      `rule: ${LIMINA_CHECK_ISSUE_CODES.sourcePackageImportUnauthorized}`,
    );
    expect(report).toContain('package manifest: packages/app/package.json');
    expect(report).toContain('packages/app/src/index.ts');
  });
});
