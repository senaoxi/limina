import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'pathe';
import picomatch from 'picomatch';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface WorkflowStep {
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: {
    filters?: string;
    name?: string;
    path?: string;
  };
}

interface WorkflowJob {
  if?: string;
  needs?: string | string[];
  steps?: WorkflowStep[];
}

interface WorkflowDocument {
  jobs?: Record<string, WorkflowJob>;
}

interface LiminaProject {
  targets?: {
    typecheck?: {
      dependsOn?: {
        projects?: string[];
        target?: string;
      }[];
    };
  };
}

const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url));

function getChangesSteps(workflow: WorkflowDocument): WorkflowStep[] {
  return workflow.jobs?.changes?.steps ?? [];
}

function getFilterSource(workflow: WorkflowDocument): string {
  const filterStep = getChangesSteps(workflow).find(
    (step) => step.id === 'filter',
  );
  const filterSource = filterStep?.with?.filters;
  if (filterSource !== undefined) return filterSource;
  throw new Error('CI changes job is missing the paths-filter configuration.');
}

async function readCiPathFilters(): Promise<Record<string, string[]>> {
  const workflowPath = path.join(workspaceRoot, '.github/workflows/ci.yml');
  const workflow = parse(
    await readFile(workflowPath, 'utf8'),
  ) as WorkflowDocument;
  return parse(getFilterSource(workflow)) as Record<string, string[]>;
}

async function readLiminaProject(): Promise<LiminaProject> {
  return JSON.parse(
    await readFile(
      path.join(workspaceRoot, 'packages/limina/project.json'),
      'utf8',
    ),
  ) as LiminaProject;
}

function applyPathPattern(
  matched: boolean,
  filePath: string,
  pattern: string,
): boolean {
  const negated = pattern.startsWith('!');
  const candidate = negated ? pattern.slice(1) : pattern;
  if (!picomatch.isMatch(filePath, candidate, { dot: true })) return matched;
  return !negated;
}

function matchesPathFilter(filePath: string, patterns: string[]): boolean {
  return patterns.reduce(
    (matched, pattern) => applyPathPattern(matched, filePath, pattern),
    false,
  );
}

describe('Limina CI change detection', () => {
  it.each([
    'packages/limina/fixtures/detectors/graph/example/case.mts',
    'packages/limina/fixtures/detectors/graph/example/repo/limina.config.mts',
    'packages/limina/fixtures/detectors/graph/example/repo/pnpm-workspace.yaml',
    'packages/limina/smoke/project.json',
    'limina.config.mts',
    'nx.json',
  ])('runs release-blocking gates for %s', async (filePath) => {
    const filters = await readCiPathFilters();

    expect(filters.src).toBeDefined();
    expect(matchesPathFilter(filePath, filters.src ?? [])).toBe(true);
  });

  it('declares the global checker build artifact closure on limina:typecheck', async () => {
    const project = await readLiminaProject();

    expect(project.targets?.typecheck?.dependsOn).toEqual([
      {
        projects: [
          '@docs-islands/agents',
          '@docs-islands/core',
          '@docs-islands/eslint-config',
          '@docs-islands/plugin-license',
          '@docs-islands/utils',
          '@docs-islands/vitepress',
          '@docs-islands/vitepress-smoke',
          'logaria',
          'logaria-plugin-test',
        ],
        target: 'build',
      },
    ]);
  });

  it('runs the exact Vue semantic adapter matrix from built artifacts', async () => {
    const workflowPath = path.join(workspaceRoot, '.github/workflows/ci.yml');
    const runnerPath = path.join(
      workspaceRoot,
      'packages/limina/fixtures/vue-semantic-matrix/run-matrix.mjs',
    );
    const [workflowSource, runnerSource] = await Promise.all([
      readFile(workflowPath, 'utf8'),
      readFile(runnerPath, 'utf8'),
    ]);
    const workflow = parse(workflowSource) as WorkflowDocument;
    const buildArtifacts = workflow.jobs?.['build-artifacts'];
    const matrix = workflow.jobs?.['limina-vue-semantic-matrix'];
    const commands =
      matrix?.steps
        ?.map((step) => step.run)
        .filter((command): command is string => command !== undefined) ?? [];
    const artifactUpload = buildArtifacts?.steps?.find(
      (step) => step.with?.name === 'packages-build-artifacts',
    );
    const artifactDownload = matrix?.steps?.find((step) =>
      step.uses?.startsWith('actions/download-artifact@'),
    );

    expect(matrix?.needs).toEqual(['changes', 'build-artifacts']);
    expect(buildArtifacts?.if).toBe(matrix?.if);
    expect(buildArtifacts?.if).not.toContain('always()');
    expect(artifactUpload?.with?.path).toContain('packages/*/dist/**');
    expect(artifactDownload?.with).toMatchObject({
      name: 'packages-build-artifacts',
      path: '.',
    });
    expect(commands).toContain(
      'pnpm --dir packages/limina/fixtures/vue-semantic-matrix install --frozen-lockfile --ignore-scripts',
    );
    expect(commands).toContain(
      'pnpm --dir packages/limina/fixtures/vue-semantic-matrix matrix',
    );
    expect(runnerSource).toContain(
      "requireFromCase.resolve('limina/package.json')",
    );
    expect(runnerSource).toContain('installed.liminaCli');
    expect(runnerSource).not.toContain("new URL('../../dist/bin/limina.js'");
    expect(runnerSource).not.toContain("new URL('../../bin/limina.js'");
  });
});
