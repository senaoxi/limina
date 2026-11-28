import { rm } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import { isRunSourceCheck } from '../commands/source';
import {
  isFinishSourceCheckAnalysis,
  prepareSourceCheck,
} from '../source-check/phases';
import type { SourceCheckIssue } from '../source-check/report';
import { withFixtureGovernanceRoot } from './helpers/governance-root';
import { createSemanticRepairFixture } from './helpers/semantic-repair';

async function createResourceFixture(
  files: Record<string, string>,
  roots: string[],
) {
  const fixture = await createSemanticRepairFixture({
    'package.json': '{"name":"fixture","private":true,"type":"module"}',
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        module: 'ESNext',
        moduleResolution: 'Bundler',
        allowArbitraryExtensions: true,
        noLib: true,
        types: [],
      },
      files: roots,
    }),
    ...files,
  });
  return {
    ...fixture,
    config: withFixtureGovernanceRoot({
      rootDir: fixture.root,
      configPath: fixture.path('limina.config.mjs'),
      scope: { checkers: { tsc: { include: ['tsconfig.json'] } } },
      source: { knip: false },
    }),
  };
}

it.each([false, true])(
  'accepts a real declaration companion without requiring root ownership: root=%s',
  async (isRoot) => {
    const fixture = await createResourceFixture(
      {
        'main.ts': "import style from './style.css'; void style;",
        'style.css': '.root {}',
        'style.d.css.ts': 'declare const style: string; export default style;',
      },
      ['main.ts', ...(isRoot ? ['style.d.css.ts'] : [])],
    );
    try {
      const sourceIssues: SourceCheckIssue[] = [];
      await isRunSourceCheck(fixture.config, {
        deferSnapshot: true,
        report: { defer: true },
        sourceIssues,
      });
      expect(sourceIssues).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  },
);

it.each([
  { ambient: false, suffix: '?raw' },
  { ambient: true, suffix: '?raw' },
  { ambient: false, suffix: '?unknown' },
  { ambient: false, suffix: '#fragment' },
  { ambient: false, suffix: '?x/../style.css' },
  { ambient: false, suffix: '#x/../style.css' },
])(
  'never derives a physical resource requirement from ./foo.ts$suffix (ambient=$ambient)',
  async ({ ambient, suffix }) => {
    const fixture = await createResourceFixture(
      {
        'main.ts': `import value from './foo.ts${suffix}'; void value;`,
        'env.d.ts': `declare module '*${suffix}' { const value: string; export default value; }`,
        'foo.ts': 'export const value = 1;',
        'style.css': '.theme {}',
      },
      ['main.ts', ...(ambient ? ['env.d.ts'] : [])],
    );
    try {
      const sourceIssues: SourceCheckIssue[] = [];
      await isRunSourceCheck(fixture.config, {
        deferSnapshot: true,
        report: { defer: true },
        sourceIssues,
      });
      expect(sourceIssues).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  },
);

it('uses the prepared physical fact for Source policy and rereads in a fresh invocation', async () => {
  const fixture = await createResourceFixture(
    {
      'main.ts': "import './theme.css';",
      'theme.css': '.theme {}',
    },
    ['main.ts'],
  );
  const preparedIssues: SourceCheckIssue[] = [];
  const state = await prepareSourceCheck(fixture.config, {
    deferSnapshot: true,
    logSuccess: false,
    report: { defer: true },
    sourceIssues: preparedIssues,
  });
  try {
    await rm(fixture.path('theme.css'));
    await expect(isFinishSourceCheckAnalysis(state)).resolves.toBe(true);
    expect(preparedIssues).toEqual([]);

    const freshIssues: SourceCheckIssue[] = [];
    await expect(
      isRunSourceCheck(fixture.config, {
        deferSnapshot: true,
        report: { defer: true },
        sourceIssues: freshIssues,
      }),
    ).resolves.toBe(false);
    expect(freshIssues).toMatchObject([
      {
        code: LIMINA_CHECK_ISSUE_CODES.sourceResourceModuleNotFound,
        facts: {
          checkedPath: fixture.path('theme.css'),
          specifier: './theme.css',
        },
      },
    ]);
  } finally {
    state.preflight.dispose();
    await fixture.cleanup();
  }
});
