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

async function readCiPathFilters(): Promise<Record<string, string[]>> {
  const workflow = parse(
    await readFile(
      path.join(workspaceRoot, '.github/workflows/ci.yml'),
      'utf8',
    ),
  ) as WorkflowDocument;
  const filterSource = workflow.jobs?.changes?.steps?.find(
    (step) => step.id === 'filter',
  )?.with?.filters;

  if (!filterSource) {
    throw new Error(
      'CI changes job is missing the paths-filter configuration.',
    );
  }

  return parse(filterSource) as Record<string, string[]>;
}

function matchesPathFilter(filePath: string, patterns: string[]): boolean {
  let matched = false;

  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    const candidate = negated ? pattern.slice(1) : pattern;

    if (picomatch.isMatch(filePath, candidate, { dot: true })) {
      matched = !negated;
    }
  }

  return matched;
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
