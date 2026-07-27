import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'pathe';
import picomatch from 'picomatch';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface WorkflowStep {
  id?: string;
  with?: {
    filters?: string;
  };
}

interface WorkflowDocument {
  jobs?: Record<
    string,
    {
      steps?: WorkflowStep[];
    }
  >;
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
});
