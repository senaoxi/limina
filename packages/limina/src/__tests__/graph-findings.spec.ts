import type { ResolvedLiminaConfig } from '#config/runner';
import { describe, expect, it } from 'vitest';

import {
  getLiminaCheckIssueRuleMetadata,
  LIMINA_CHECK_ISSUE_CODES,
  listLiminaCheckIssueCodes,
} from '../check-reporting/codes';
import {
  createGraphCheckIssueFromFinding,
  GRAPH_SEMANTIC_ISSUE_CODES,
  type GraphFinding,
  type GraphFindingForCode,
  type GraphFindingPresentation,
  type GraphImportFact,
  type GraphSemanticIssueCode,
} from '../graph-check/findings';

const config = {
  configPath: '/repo/limina.config.mts',
  rootDir: '/repo',
} as ResolvedLiminaConfig;

const importFact: GraphImportFact = {
  filePath: '/repo/packages/app/src/index.ts',
  kind: 'static-import',
  line: 3,
  specifier: '@example/lib',
};

function presentation(title: string): GraphFindingPresentation {
  return {
    detailLines: [`${title}:`, '  display label: presentation-only'],
    reason: `${title} reason`,
    title,
  };
}

function commonFindingFields(title: string) {
  return {
    checkerName: 'typescript',
    evidence: [
      {
        label: 'semantic-only evidence',
        value: title,
      },
    ],
    filePath: '/repo/packages/app/tsconfig.lib.dts.json',
    locations: [
      {
        filePath: '/repo/packages/app/tsconfig.lib.dts.json',
        label: 'project',
      },
    ],
    presentation: presentation(title),
    task: 'graph:check' as const,
  };
}

type GraphFindingMatrix = {
  readonly [Code in GraphSemanticIssueCode]: GraphFindingForCode<Code>;
};

const findingByCode = {
  [LIMINA_CHECK_ISSUE_CODES.graphAccessDenied]: {
    ...commonFindingFields('Denied graph access'),
    code: LIMINA_CHECK_ISSUE_CODES.graphAccessDenied,
    facts: {
      deniedDependency: '@example/lib',
      import: importFact,
      importingProjectPath: '/repo/packages/app/tsconfig.lib.dts.json',
      kind: 'import-dependency',
      labels: ['browser'],
      ruleReason: 'Browser projects cannot import the server package.',
    },
    packageName: '@example/lib',
  },
  [LIMINA_CHECK_ISSUE_CODES.graphConditionDomainMismatch]: {
    ...commonFindingFields('Graph condition domain customConditions mismatch'),
    code: LIMINA_CHECK_ISSUE_CODES.graphConditionDomainMismatch,
    facts: {
      actualConditions: ['source'],
      domainName: 'browser',
      entryProjectPath: '/repo/packages/app/tsconfig.lib.dts.json',
      expectedConditions: ['browser', 'source'],
      kind: 'domain-entry',
    },
  },
  [LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid]: {
    ...commonFindingFields('Invalid graph rule config'),
    code: LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
    facts: {
      configPath: '/repo/limina.config.mts',
      field: 'graph.rules.browser',
      kind: 'graph-rule',
    },
    filePath: '/repo/limina.config.mts',
    locations: [
      {
        filePath: '/repo/limina.config.mts',
        label: 'Limina config',
      },
    ],
  },
  [LIMINA_CHECK_ISSUE_CODES.graphImportTargetUnmapped]: {
    ...commonFindingFields('Unable to map workspace import'),
    code: LIMINA_CHECK_ISSUE_CODES.graphImportTargetUnmapped,
    facts: {
      import: importFact,
      importingProjectPath: '/repo/packages/app/tsconfig.lib.dts.json',
      resolvedFilePath: '/repo/packages/lib/src/index.ts',
      targetPackageName: '@example/lib',
    },
    filePath: importFact.filePath,
    packageName: '@example/lib',
  },
  [LIMINA_CHECK_ISSUE_CODES.graphReferenceCycle]: {
    ...commonFindingFields('Generated project reference cycle'),
    code: LIMINA_CHECK_ISSUE_CODES.graphReferenceCycle,
    facts: {
      edges: [
        {
          from: '/repo/packages/app/tsconfig.lib.dts.json',
          to: '/repo/packages/lib/tsconfig.lib.dts.json',
        },
        {
          from: '/repo/packages/lib/tsconfig.lib.dts.json',
          to: '/repo/packages/app/tsconfig.lib.dts.json',
        },
      ],
      projectPaths: [
        '/repo/packages/app/tsconfig.lib.dts.json',
        '/repo/packages/lib/tsconfig.lib.dts.json',
      ],
    },
  },
  [LIMINA_CHECK_ISSUE_CODES.graphReferenceExtra]: {
    ...commonFindingFields('Extra project reference'),
    code: LIMINA_CHECK_ISSUE_CODES.graphReferenceExtra,
    facts: {
      extraReferencePath: '/repo/packages/lib/tsconfig.lib.dts.json',
      projectPath: '/repo/packages/app/tsconfig.lib.dts.json',
    },
  },
  [LIMINA_CHECK_ISSUE_CODES.graphReferenceMissing]: {
    ...commonFindingFields('Missing project reference'),
    code: LIMINA_CHECK_ISSUE_CODES.graphReferenceMissing,
    facts: {
      expectedReferencePath: '/repo/packages/lib/tsconfig.lib.dts.json',
      imports: [importFact],
      projectPath: '/repo/packages/app/tsconfig.lib.dts.json',
    },
  },
  [LIMINA_CHECK_ISSUE_CODES.graphTargetUnreachable]: {
    ...commonFindingFields('Expected graph target is not reachable'),
    code: LIMINA_CHECK_ISSUE_CODES.graphTargetUnreachable,
    facts: {
      import: importFact,
      importingProjectPath: '/repo/packages/app/tsconfig.lib.dts.json',
      targetProjectPath: '/repo/packages/lib/tsconfig.lib.dts.json',
    },
    filePath: importFact.filePath,
  },
  [LIMINA_CHECK_ISSUE_CODES.graphWorkspaceDependencyUndeclared]: {
    ...commonFindingFields('Workspace dependency is not declared'),
    code: LIMINA_CHECK_ISSUE_CODES.graphWorkspaceDependencyUndeclared,
    facts: {
      packageManifestPath: '/repo/packages/app/package.json',
      referencedPackageName: '@example/lib',
      referencedProjectPath: '/repo/packages/lib/tsconfig.lib.dts.json',
      referencingPackageName: '@example/app',
      referencingProjectPath: '/repo/packages/app/tsconfig.lib.dts.json',
    },
    packageManifestPath: '/repo/packages/app/package.json',
    packageName: '@example/app',
  },
  [LIMINA_CHECK_ISSUE_CODES.graphWorkspaceImportOutsideGraph]: {
    ...commonFindingFields('Workspace import resolved outside graph'),
    code: LIMINA_CHECK_ISSUE_CODES.graphWorkspaceImportOutsideGraph,
    facts: {
      import: importFact,
      importingProjectPath: '/repo/packages/app/tsconfig.lib.dts.json',
      kind: 'outside-workspace-graph',
      resolvedFilePath: '/repo/packages/lib/dist/index.js',
      targetPackageName: '@example/lib',
    },
    filePath: importFact.filePath,
    packageName: '@example/lib',
  },
  [LIMINA_CHECK_ISSUE_CODES.graphWorkspaceImportUnresolved]: {
    ...commonFindingFields('Unresolved workspace import'),
    code: LIMINA_CHECK_ISSUE_CODES.graphWorkspaceImportUnresolved,
    facts: {
      import: importFact,
      importingProjectPath: '/repo/packages/app/tsconfig.lib.dts.json',
      kind: 'unresolved',
      targetPackageName: '@example/lib',
    },
    filePath: importFact.filePath,
    packageName: '@example/lib',
  },
  [LIMINA_CHECK_ISSUE_CODES.graphWorkspacePackageNameMissing]: {
    ...commonFindingFields('Workspace package name is missing'),
    code: LIMINA_CHECK_ISSUE_CODES.graphWorkspacePackageNameMissing,
    facts: {
      packageManifestPath: '/repo/packages/lib/package.json',
      packageRole: 'referenced',
      referencedProjectPath: '/repo/packages/lib/tsconfig.lib.dts.json',
      referencingProjectPath: '/repo/packages/app/tsconfig.lib.dts.json',
    },
    packageManifestPath: '/repo/packages/lib/package.json',
  },
} satisfies GraphFindingMatrix;

function graphFindingEntries(): readonly [
  GraphSemanticIssueCode,
  GraphFinding,
][] {
  return Object.entries(findingByCode) as [
    GraphSemanticIssueCode,
    GraphFinding,
  ][];
}

describe('typed Graph findings', () => {
  it('covers every current graph:check semantic code exactly once', () => {
    const registryCodes = listLiminaCheckIssueCodes()
      .filter(
        (code) =>
          getLiminaCheckIssueRuleMetadata(code).task === 'graph:check' &&
          code !== LIMINA_CHECK_ISSUE_CODES.graphCheckFailed,
      )
      .sort();

    expect([...GRAPH_SEMANTIC_ISSUE_CODES].sort()).toEqual(registryCodes);
    expect(Object.keys(findingByCode).sort()).toEqual(registryCodes);
  });

  it.each(graphFindingEntries())(
    'adapts %s without inferring code, task, location, checker, or evidence',
    (code, finding) => {
      const issue = createGraphCheckIssueFromFinding({ config, finding });

      expect(issue).toMatchObject({
        checkerName: finding.checkerName,
        code,
        evidence: finding.evidence,
        task: 'graph:check',
        title: finding.presentation.title,
      });
      expect(issue.filePath).toBe(finding.filePath.replace('/repo/', ''));
      expect(issue.locations).toHaveLength(finding.locations.length);

      if ('packageManifestPath' in finding) {
        expect(issue.packageManifestPath).toBe(
          finding.packageManifestPath?.replace('/repo/', ''),
        );
      }

      if ('packageName' in finding) {
        expect(issue.packageName).toBe(finding.packageName);
      }
    },
  );

  it('keeps producer-selected code when human title implies another rule', () => {
    const finding = findingByCode[LIMINA_CHECK_ISSUE_CODES.graphReferenceExtra];
    const issue = createGraphCheckIssueFromFinding({
      config,
      finding: {
        ...finding,
        presentation: presentation(
          'Missing project reference with deliberately misleading wording',
        ),
      },
    });

    expect(issue.code).toBe(LIMINA_CHECK_ISSUE_CODES.graphReferenceExtra);
    expect(issue.task).toBe('graph:check');
  });

  it('keeps structured file and package fields when display labels change', () => {
    const finding =
      findingByCode[
        LIMINA_CHECK_ISSUE_CODES.graphWorkspaceDependencyUndeclared
      ];
    const issue = createGraphCheckIssueFromFinding({
      config,
      finding: {
        ...finding,
        presentation: {
          ...finding.presentation,
          detailLines: [
            'Display layout changed:',
            '  renamed-project-label: presentation-only',
            '  renamed-package-label: presentation-only',
          ],
        },
      },
    });

    expect(issue).toMatchObject({
      code: LIMINA_CHECK_ISSUE_CODES.graphWorkspaceDependencyUndeclared,
      filePath: 'packages/app/tsconfig.lib.dts.json',
      packageManifestPath: 'packages/app/package.json',
      packageName: '@example/app',
      task: 'graph:check',
    });
  });

  it('still rejects a runtime code/task mismatch through the canonical writer', () => {
    const finding =
      findingByCode[LIMINA_CHECK_ISSUE_CODES.graphReferenceMissing];

    expect(() =>
      createGraphCheckIssueFromFinding({
        config,
        finding: {
          ...finding,
          task: 'source:check',
        } as unknown as GraphFinding,
      }),
    ).toThrow(
      'Issue code LIMINA_GRAPH_REFERENCE_MISSING belongs to graph:check, not source:check.',
    );
  });
});
