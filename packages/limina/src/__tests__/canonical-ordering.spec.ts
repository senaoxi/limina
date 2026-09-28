import type {
  ResolvedCheckerConfig,
  ResolvedLiminaConfig,
} from '#config/runner';
import type { WorkspacePackage } from '#core/workspace/actions';
import {
  compareCodeUnits,
  uniqueCodeUnitSortedStrings,
  uniqueSortedStrings,
} from '#utils/collections';
import { describe, expect, it, vi } from 'vitest';
import { createManifest } from '../core/build-graph/manifest';
import type {
  GeneratedBuildModule,
  GeneratedDependencyEdge,
  GeneratedTsconfigGraphManifest,
} from '../core/build-graph/runner';
import { findTargetProject } from '../core/import-graph/project-lookup';
import { createNodes, sortEdges } from '../dependency-graph/model';
import type { DependencyGraphEdge } from '../dependency-graph/types';
import { createMaterializationRevision } from '../domain/artifacts/plan';
import {
  compareGovernanceIssues,
  type GovernanceIssue,
  sortGovernanceIssues,
} from '../domain/validation/issues';
import type { SourceFinding } from '../source-check/findings';
import { addNearestTsconfigOwnershipProblem } from '../source-check/tsconfig-ownership-finding';

const unicodeValues = ['z', 'ä', 'a'] as const;

function createChecker(): ResolvedCheckerConfig {
  return {
    exclude: [],
    extensions: ['.ts'],
    include: ['packages/*/tsconfig.json'],
    name: 'tsc',
  };
}

function createBuildModules(
  rootDir: string,
  values: readonly string[],
): Map<string, GeneratedBuildModule> {
  return new Map(
    values.map((value) => [
      `${rootDir}/packages/${value}/tsconfig.json`,
      {
        kind: 'project' as const,
        path: `${rootDir}/.limina/${value}.json`,
      },
    ]),
  );
}

function createTestManifest(
  rootDir: string,
  values: readonly string[],
): GeneratedTsconfigGraphManifest {
  const checker = createChecker();
  const vueChecker: ResolvedCheckerConfig = {
    ...checker,
    name: 'vue-tsc',
  };
  const modules = createBuildModules(rootDir, values);
  const dependencyEdges: GeneratedDependencyEdge[] = values.map((value) => ({
    cacheReuse: 'reusable',
    file: `${rootDir}/packages/${value}/src/index.ts`,
    fromChecker: value,
    fromConfigPath: `${rootDir}/packages/${value}/tsconfig.json`,
    importedSpecifier: value,
    kind: 'declaration-provider',
    resolvedFilePath: `${rootDir}/packages/${value}/src/value.ts`,
    toChecker: value,
    toConfigPath: `${rootDir}/packages/${value}/tsconfig.lib.json`,
  }));
  return createManifest({
    checkerEntries: new Map([
      [vueChecker.name, `${rootDir}/.limina/vue.build.json`],
      [checker.name, `${rootDir}/.limina/tsconfig.build.json`],
    ]),
    checkers: [vueChecker, checker],
    configToOutputBuildByChecker: new Map([[checker.name, modules]]),
    generatedKnipDiagnostics: values.map((value) => ({
      command: value,
      packageJsonPath: value,
      packageName: value,
      reason: value,
      scriptName: value,
    })),
    generatedKnipPackageConfigs: values.map((value) => ({
      configPath: value,
      packageDirectory: value,
      packageJsonPath: value,
      packageName: value,
      references: [...values],
      scripts: values.map((scriptValue) => ({
        checker: 'tsc',
        command: scriptValue,
        configPath: scriptValue,
        mode: 'managed',
        name: scriptValue,
      })),
    })),
    governedSourcesByChecker: new Map(),
    ownedArtifacts: values.map((value) => `${value}.json`),
    projectsByChecker: new Map(),
    dependencyEdges,
    rootDir,
    sourceToBuildByChecker: new Map([[checker.name, modules]]),
  });
}

function createGovernanceIssue(value: string): GovernanceIssue {
  return {
    category: 'architecture',
    documentation: 'https://example.com/rule',
    evidence: [],
    id: value as GovernanceIssue['id'],
    location: { path: value },
    message: value,
    messageId: 'message',
    origin: { kind: 'built-in', suite: 'architecture' },
    ruleId: value as GovernanceIssue['ruleId'],
    severity: 'error',
    title: value,
  };
}

describe('canonical code-unit ordering', () => {
  it('orders strings by UTF-16 code units and returns zero for equality', () => {
    expect([...unicodeValues].sort(compareCodeUnits)).toEqual(['a', 'z', 'ä']);
    expect(compareCodeUnits('same', 'same')).toBe(0);
  });

  it('keeps canonical and human string sorting as separate contracts', () => {
    const localeCompare = vi
      .spyOn(String.prototype, 'localeCompare')
      .mockImplementation(function (this: string, right) {
        return compareCodeUnits(String(right), String(this));
      });

    try {
      expect(uniqueCodeUnitSortedStrings(unicodeValues)).toEqual([
        'a',
        'z',
        'ä',
      ]);
      expect(uniqueSortedStrings(unicodeValues)).toEqual(['ä', 'z', 'a']);
    } finally {
      localeCompare.mockRestore();
    }
  });

  it('uses canonical tie-breakers for graph evidence, edges, and governance issues', () => {
    const evidenceEdges: DependencyGraphEdge[] = [
      {
        evidence: [
          { importer: 'same', resolvedPath: 'ä', specifier: 'same' },
          { importer: 'same', resolvedPath: 'a', specifier: 'same' },
          { importer: 'same', resolvedPath: 'same', specifier: 'ä' },
          { importer: 'same', resolvedPath: 'same', specifier: 'a' },
        ],
        from: 'same',
        kind: 'source',
        to: 'same',
      },
    ];
    const edgeTieBreakers: DependencyGraphEdge[] = [
      { evidence: [], from: 'same', kind: 'source', to: 'ä' },
      { evidence: [], from: 'same', kind: 'source', to: 'a' },
      { evidence: [], from: 'same', kind: 'artifact', to: 'same' },
      { evidence: [], from: 'same', kind: 'source', to: 'same' },
    ];
    const baseIssue = createGovernanceIssue('same');
    const issues = [
      { ...baseIssue, id: 'ä' as GovernanceIssue['id'] },
      { ...baseIssue, id: 'a' as GovernanceIssue['id'] },
      { ...baseIssue, message: 'ä' },
      { ...baseIssue, message: 'a' },
      { ...baseIssue, location: { path: 'ä' } },
      { ...baseIssue, location: { path: 'a' } },
    ];

    expect(sortEdges(evidenceEdges)[0]!.evidence).toEqual([
      { importer: 'same', resolvedPath: 'same', specifier: 'a' },
      { importer: 'same', resolvedPath: 'a', specifier: 'same' },
      { importer: 'same', resolvedPath: 'ä', specifier: 'same' },
      { importer: 'same', resolvedPath: 'same', specifier: 'ä' },
    ]);
    expect(
      sortEdges(edgeTieBreakers).map(({ kind, to }) => [to, kind]),
    ).toEqual([
      ['a', 'source'],
      ['same', 'artifact'],
      ['same', 'source'],
      ['ä', 'source'],
    ]);
    expect([...issues].sort(compareGovernanceIssues)).toEqual([
      { ...baseIssue, location: { path: 'a' } },
      { ...baseIssue, message: 'a' },
      { ...baseIssue, id: 'a' as GovernanceIssue['id'] },
      { ...baseIssue, id: 'ä' as GovernanceIssue['id'] },
      { ...baseIssue, message: 'ä' },
      { ...baseIssue, location: { path: 'ä' } },
    ]);
  });

  it('selects equal-depth graph owners independently of localeCompare', () => {
    const resolvedFilePath = '/workspace/packages/shared/src/index.ts';
    const ownerProjectPaths = [
      '/workspace/packages/ä/tsconfig.json',
      '/workspace/packages/a/tsconfig.json',
      '/workspace/packages/z/tsconfig.json',
    ];
    const localeCompare = vi
      .spyOn(String.prototype, 'localeCompare')
      .mockImplementation(() => {
        throw new Error('graph owner selection used localeCompare');
      });

    try {
      expect(
        findTargetProject({
          fileOwnerLookup: new Map([[resolvedFilePath, ownerProjectPaths]]),
          packages: [],
          projectPaths: ownerProjectPaths,
          resolvedFilePath,
          specifier: './index.js',
        }),
      ).toBe('/workspace/packages/a/tsconfig.json');
    } finally {
      localeCompare.mockRestore();
    }
  });

  it('keeps source finding semantic facts independent of localeCompare', () => {
    const rootDir = '/workspace';
    const findings: SourceFinding[] = [];
    const localeCompare = vi
      .spyOn(String.prototype, 'localeCompare')
      .mockImplementation(() => {
        throw new Error('canonical source finding used localeCompare');
      });

    try {
      addNearestTsconfigOwnershipProblem({
        config: { rootDir } as ResolvedLiminaConfig,
        fileName: `${rootDir}/src/index.ts`,
        findings,
        matchedOwnerConfigPaths: [
          `${rootDir}/packages/ä/tsconfig.json`,
          `${rootDir}/packages/a/tsconfig.json`,
          `${rootDir}/packages/z/tsconfig.json`,
        ],
        reason: 'test reason',
        searchedTsconfigPaths: [
          `${rootDir}/search/ä/tsconfig.json`,
          `${rootDir}/search/a/tsconfig.json`,
          `${rootDir}/search/z/tsconfig.json`,
        ],
        status: 'multiple',
        tsconfigPath: null,
      });

      expect(findings).toHaveLength(1);
      expect(findings[0]!.facts).toMatchObject({
        candidateConfigPaths: [
          `${rootDir}/search/a/tsconfig.json`,
          `${rootDir}/search/z/tsconfig.json`,
          `${rootDir}/search/ä/tsconfig.json`,
        ],
        matchedConfigPaths: [
          `${rootDir}/packages/a/tsconfig.json`,
          `${rootDir}/packages/z/tsconfig.json`,
          `${rootDir}/packages/ä/tsconfig.json`,
        ],
      });
    } finally {
      localeCompare.mockRestore();
    }
  });

  it('keeps graph, manifest, revisions, and governance issues independent of localeCompare', () => {
    const rootDir = '/workspace';
    const config = { rootDir } as ResolvedLiminaConfig;
    const packages: WorkspacePackage[] = unicodeValues.map((name) => ({
      directory: `${rootDir}/packages/${name}`,
      manifest: { name },
      name,
    }));
    const edges: DependencyGraphEdge[] = unicodeValues.map((value) => ({
      evidence: unicodeValues.map((evidenceValue) => ({
        importer: evidenceValue,
        resolvedPath: evidenceValue,
        specifier: evidenceValue,
      })),
      from: value,
      kind: 'source',
      to: value,
    }));
    const localeCompare = vi
      .spyOn(String.prototype, 'localeCompare')
      .mockImplementation(() => {
        throw new Error('canonical ordering used localeCompare');
      });

    try {
      const nodes = createNodes(config, packages);
      const sortedEdges = sortEdges(edges);
      const reversedNodes = createNodes(config, packages.toReversed());
      const reversedEdges = sortEdges(
        edges.toReversed().map((edge) => ({
          ...edge,
          evidence: edge.evidence.toReversed(),
        })),
      );
      const manifest = createTestManifest(rootDir, unicodeValues);
      const reversedManifest = createTestManifest(
        rootDir,
        unicodeValues.toReversed(),
      );
      const revision = createMaterializationRevision(
        unicodeValues.map((value) => ({ content: value, path: value })),
      );
      const reversedRevision = createMaterializationRevision(
        unicodeValues
          .toReversed()
          .map((value) => ({ content: value, path: value })),
      );
      const issues = sortGovernanceIssues(
        unicodeValues.map(createGovernanceIssue),
      );

      expect(nodes.map((node) => node.name)).toEqual(['a', 'z', 'ä']);
      expect(sortedEdges.map((edge) => edge.from)).toEqual(['a', 'z', 'ä']);
      for (const edge of sortedEdges) {
        expect(edge.evidence.map((evidence) => evidence.importer)).toEqual([
          'a',
          'z',
          'ä',
        ]);
      }
      expect(JSON.stringify({ edges: sortedEdges, nodes })).toBe(
        JSON.stringify({ edges: reversedEdges, nodes: reversedNodes }),
      );
      expect(Object.keys(manifest.checkers.tsc!.sourceToBuild)).toEqual([
        'packages/a/tsconfig.json',
        'packages/z/tsconfig.json',
        'packages/ä/tsconfig.json',
      ]);
      expect(Object.keys(manifest.checkers)).toEqual(['tsc', 'vue-tsc']);
      expect(manifest.ownedArtifacts).toEqual(['a.json', 'z.json', 'ä.json']);
      expect(manifest.knip.packages.map((entry) => entry.packageName)).toEqual([
        'a',
        'z',
        'ä',
      ]);
      for (const packageConfig of manifest.knip.packages) {
        expect(packageConfig.references).toEqual(['a', 'z', 'ä']);
        expect(packageConfig.scripts.map((script) => script.name)).toEqual([
          'a',
          'z',
          'ä',
        ]);
      }
      expect(
        manifest.knip.diagnostics.map((entry) => entry.packageName),
      ).toEqual(['a', 'z', 'ä']);
      expect(manifest.dependencyEdges.map((edge) => edge.fromChecker)).toEqual([
        'a',
        'z',
        'ä',
      ]);
      expect(JSON.stringify(manifest)).toBe(JSON.stringify(reversedManifest));
      expect(revision).toBe(reversedRevision);
      expect(issues.map((issue) => issue.ruleId)).toEqual(['a', 'z', 'ä']);
    } finally {
      localeCompare.mockRestore();
    }
  });
});
