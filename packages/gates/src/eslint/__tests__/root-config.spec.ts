import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { describe, expect, it } from 'vitest';

const repoDirectory = fileURLToPath(
  new URL('../../../../../', import.meta.url),
);
const repoConfigPath = fileURLToPath(
  new URL('../../../../../eslint.config.mjs', import.meta.url),
);
const eslint = new ESLint({
  cwd: repoDirectory,
  overrideConfigFile: repoConfigPath,
});

async function lintSource(source: string, filePath: string) {
  const options = await resolveConfig(repoConfigPath);
  const formatted = await format(source, {
    ...options,
    parser: 'typescript',
    // Preserve intentionally invalid imports in diagnostic samples.
    plugins: [],
  });
  const [result] = await eslint.lintText(formatted, { filePath });
  expect(result?.fatalErrorCount).toBe(0);
  return result!;
}

function cohesiveSource(statements: number, branches = 0): string {
  return `
    export function evaluate(first: number, second: number, third: number, fourth: number): number {
      let total = first;
      ${Array.from({ length: statements }, (_, index) => `total += first + ${index};`).join('\n')}
      ${Array.from({ length: branches }, (_, index) => `if (second > ${index}) total += ${index + 1};`).join('\n')}
      if (first > 0) {
        if (second > 0) {
          if (third > 0) {
            if (fourth > 0) {
              return total + second + third + fourth;
            }
          }
        }
      }
      return total;
    }
  `;
}

describe('repository ESLint composition', () => {
  it.each(['packages/limina/src/index.ts', 'packages/migrate/src/cli.ts'])(
    'allows cohesive production code in %s without numeric size limits',
    async (filePath) => {
      const result = await lintSource(cohesiveSource(310), filePath);
      expect(result.messages).toEqual([]);
    },
  );

  it('preserves advisory size budgets for tooling', async () => {
    const script = await lintSource(
      cohesiveSource(1210, 42),
      'scripts/release.ts',
    );
    expect(script.messages.filter(({ severity }) => severity === 2)).toEqual(
      [],
    );
    expect(new Set(script.messages.map(({ ruleId }) => ruleId))).toEqual(
      new Set(['complexity', 'max-lines', 'max-lines-per-function']),
    );
  });

  it.each([
    'scripts/release/publication.spec.ts',
    'packages/gates/src/commit/staged.spec.ts',
  ])('keeps tooling size advice out of %s', async (filePath) => {
    const result = await lintSource(cohesiveSource(1210, 42), filePath);
    expect(result.messages).toEqual([]);
  });

  it('retains correctness and type-import checks for production code', async () => {
    for (const [source, ruleId] of [
      [
        'const unused = 1; export const used = 2;',
        '@typescript-eslint/no-unused-vars',
      ],
      ["export function fail(): never { throw 'bad'; }", 'no-throw-literal'],
      [
        "import { Stats } from 'node:fs'; export function size(stat: Stats): number { return stat.size; }",
        '@typescript-eslint/consistent-type-imports',
      ],
    ] as const) {
      const result = await lintSource(source, 'packages/limina/src/index.ts');
      expect(result.messages.map((message) => message.ruleId)).toEqual([
        ruleId,
      ]);
      expect(result.errorCount).toBe(1);
    }
    const valid = await lintSource(
      "import type { Stats } from 'node:fs'; export function size(stat: Stats): number { return stat.size; }",
      'packages/limina/src/index.ts',
    );
    expect(valid.messages).toEqual([]);
    const unusedDisable = await lintSource(
      '// eslint-disable-next-line no-eval\nexport const value = 1;',
      'packages/limina/src/index.ts',
    );
    expect(unusedDisable.errorCount).toBe(1);
    expect(unusedDisable.messages[0]?.message).toContain(
      'Unused eslint-disable directive',
    );
  });

  it('keeps portable-path guards and existing fixture and output exclusions', async () => {
    const filePath = 'packages/gates/src/eslint/__tests__/root-config.spec.ts';
    const invalid = await lintSource(
      "import path from 'node:path'; export function assertPath(result: {rootDir: string}, rootDirectory: string): void { expect(result.rootDir).toBe(path.join(rootDirectory, 'packages/a')); }",
      filePath,
    );
    expect(invalid.messages.map(({ ruleId }) => ruleId)).toEqual([
      '@limina/portable-path/portable-path-comparison',
    ]);
    const valid = await lintSource(
      "export function assertPath(result: {rootDir: string}, fixture: {path(value: string): string}): void { expect(result.rootDir).toBe(fixture.path('packages/a')); }",
      filePath,
    );
    expect(valid.messages).toEqual([]);
    for (const excluded of [
      'packages/limina/fixtures/sample/src/index.ts',
      'packages/limina/dist/index.js',
    ]) {
      expect(await eslint.isPathIgnored(excluded)).toBe(true);
    }
  });
});
