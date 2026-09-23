import type { ResolvedLiminaConfig } from '#config/runner';
import type { ProjectInfo } from '#core/import-graph/context';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createCheckCounter } from '../check-reporting/stats';
import { addDefaultCustomConditionProblems } from '../graph-check/condition-defaults';
import { addConditionDomainProblems } from '../graph-check/condition-domains';
import { createCustomConditionConsistencyContext } from '../graph-check/condition-subtree';
import type { GraphFinding } from '../graph-check/findings';
import { createFixturePathResolver } from './helpers/path';

const fixturePath = createFixturePathResolver(
  path.resolve('virtual-condition-dag'),
);
const config: ResolvedLiminaConfig = {
  rootDir: fixturePath(),
  configPath: fixturePath('limina.config.mjs'),
};

function createProjects(
  depth: number,
  width: number,
  mismatched: boolean,
): ProjectInfo[] {
  const projects: ProjectInfo[] = [];
  const name = (level: number, branch: number) =>
    fixturePath(`tsconfig.l${level}-${branch}.dts.json`);
  const leaf = fixturePath('tsconfig.leaf.dts.json');
  for (let level = 0; level < depth; level += 1) {
    for (let branch = 0; branch < width; branch += 1) {
      projects.push({
        configPath: name(level, branch),
        references: new Set(
          level === depth - 1
            ? [leaf]
            : Array.from({ length: width }, (_, next) => name(level + 1, next)),
        ),
        options: { customConditions: ['source', 'source'] },
      } as ProjectInfo);
    }
  }
  projects.push({
    configPath: leaf,
    references: new Set(),
    options: { customConditions: mismatched ? ['browser'] : ['source'] },
  } as ProjectInfo);
  return projects;
}

function edgeOracle(projects: ProjectInfo[]) {
  const byPath = new Map(
    projects.map((project) => [project.configPath, project]),
  );
  const conditions = (project: ProjectInfo) =>
    [...new Set(project.options.customConditions)].sort();
  return projects
    .flatMap((project) =>
      [...project.references].flatMap((reference) => {
        const target = byPath.get(reference)!;
        const expectedConditions = conditions(project);
        const actualConditions = conditions(target);
        return JSON.stringify(expectedConditions) ===
          JSON.stringify(actualConditions)
          ? []
          : [
              {
                kind: 'reference-tree',
                rootProjectPath: project.configPath,
                referencedProjectPath: reference,
                expectedConditions,
                actualConditions,
              },
            ];
      }),
    )
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
}

it.each([
  { depth: 19, width: 2, mismatch: true },
  { depth: 11, width: 3, mismatch: true },
  { depth: 40, width: 1, mismatch: true },
  { depth: 19, width: 2, mismatch: false },
])(
  'retains one finding per edge in a $depth x $width DAG (mismatch=$mismatch)',
  ({ depth, width, mismatch }) => {
    const projects = createProjects(depth, width, mismatch);
    const oracle = edgeOracle(projects);
    const outputs: GraphFinding[][] = [];
    for (const ordered of [projects, projects.toReversed()]) {
      const context = createCustomConditionConsistencyContext(
        new Map(ordered.map((project) => [project.configPath, project])),
        new Map(projects.map((project) => [project.configPath, 'tsc'])),
      );
      const findings: GraphFinding[] = [];
      addDefaultCustomConditionProblems({
        checks: createCheckCounter(),
        config,
        consistencyContext: context,
        findings,
        projects: ordered,
      });
      expect(
        findings
          .map((finding) => finding.facts)
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      ).toEqual(oracle);
      expect(context.mismatchFindingsByIdentity.size).toBe(oracle.length);
      expect(new Set(context.mismatchFindingsByIdentity.values()).size).toBe(
        oracle.length,
      );
      const summaries = [...context.subtreeByProjectPath.values()];
      expect(
        summaries.reduce(
          (sum, summary) => sum + summary.mismatchFindingIdentities.size,
          0,
        ),
      ).toBeLessThanOrEqual(projects.length * oracle.length);
      expect(findings.every((finding) => finding.checkerName === 'tsc')).toBe(
        true,
      );
      outputs.push(findings);
    }
    expect(outputs[0]).toEqual(outputs[1]);
  },
);

it('deduplicates overlapping defaults and named condition domains globally', () => {
  const projects = createProjects(4, 2, true);
  const byPath = new Map(
    projects.map((project) => [project.configPath, project]),
  );
  const context = createCustomConditionConsistencyContext(byPath);
  const findings: GraphFinding[] = [];
  const checks = createCheckCounter();
  addDefaultCustomConditionProblems({
    checks,
    config,
    consistencyContext: context,
    findings,
    projects,
  });
  const domains = ['second', 'first', 'first'].map((name) => ({
    name,
    entry: 'tsconfig.l0-0.dts.json',
    customConditions: ['different'],
  }));
  addConditionDomainProblems({
    checks,
    config: { ...config, graph: { conditionDomains: domains } },
    consistencyContext: context,
    findings,
    projectsByPath: byPath,
    generatedGraph: {
      sourceToDts: new Map(),
      generatedFiles: new Map(
        projects.map((project) => [project.configPath, '{}']),
      ),
    } as unknown as Parameters<
      typeof addConditionDomainProblems
    >[0]['generatedGraph'],
  });
  expect(findings).toHaveLength(4);
  expect(context.mismatchFindingsByIdentity.size).toBe(4);
  expect(
    findings.map((finding) =>
      'kind' in finding.facts ? finding.facts.kind : undefined,
    ),
  ).toEqual([
    'reference-tree',
    'reference-tree',
    'domain-entry',
    'domain-entry',
  ]);
  expect(findings.slice(2).map((finding) => finding.facts)).toMatchObject([
    { domainName: 'first' },
    { domainName: 'second' },
  ]);
});
