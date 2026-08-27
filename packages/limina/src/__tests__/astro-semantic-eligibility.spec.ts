import { createAstroSemanticProject } from '#checkers';
import type { ImportRecord } from '#core/import-analysis/runner';
import { describe, expect, it } from 'vitest';
import { classifyAstroSemanticEligibility } from '../core/import-analysis/semantic-eligibility';

function createRecord(options: {
  domain?: ImportRecord['domain'];
  filePath?: string;
  specifier: string;
}): ImportRecord {
  return {
    domain: options.domain ?? 'astro-frontmatter',
    filePath: options.filePath ?? '/workspace/src/Page.astro',
    kind: 'static',
    line: 2,
    locator: { occurrence: 0, sourceEnd: 24, sourceStart: 10 },
    specifier: options.specifier,
  };
}

describe('Astro pre-semantic eligibility', () => {
  it('distinguishes not-applicable, skip, and eligible without reading the project snapshot', () => {
    let snapshotReads = 0;
    const project = createAstroSemanticProject({
      analysisGeneration: 1,
      configPath: '/workspace/tsconfig.json',
      packageRootDir: '/workspace',
      projectFingerprint: 'tsconfig.json',
      readSnapshot: () => {
        snapshotReads += 1;
        return {
          checkerExtensions: ['.vue'],
          compilerOptions: {},
          configClosure: [
            {
              contentHash: 'fixture-config',
              filePath: '/workspace/tsconfig.json',
            },
          ],
          fileNames: ['/workspace/src/Page.astro'],
          projectReferences: undefined,
        };
      },
    });
    const classify = (
      specifier: string,
      overrides: {
        importRecord?: ImportRecord;
        oxcResolvedFilePath?: string | null;
      } = {},
    ) =>
      classifyAstroSemanticEligibility({
        checkerExtensions: ['.astro', '.vue'],
        importRecord: overrides.importRecord ?? createRecord({ specifier }),
        oxcResolvedFilePath: overrides.oxcResolvedFilePath ?? null,
        project,
        specifier,
      });

    expect(
      classifyAstroSemanticEligibility({
        checkerExtensions: ['.astro'],
        importRecord: createRecord({ specifier: './target.ts' }),
        oxcResolvedFilePath: null,
        project: undefined,
        specifier: './target.ts',
      }).kind,
    ).toBe('not-applicable');
    expect(
      classify('./target.ts', {
        importRecord: createRecord({
          domain: 'typescript',
          filePath: '/workspace/src/index.ts',
          specifier: './target.ts',
        }),
      }).kind,
    ).toBe('not-applicable');
    expect(classify('astro:content').kind).toBe('skip');
    expect(classify('./theme.css?inline').kind).toBe('skip');
    expect(classify('./theme.css').kind).toBe('skip');
    expect(classify('./data.json').kind).toBe('eligible');
    expect(
      classify('./asset', {
        oxcResolvedFilePath: '/workspace/src/asset.png',
      }).kind,
    ).toBe('skip');
    expect(classify('./component').kind).toBe('eligible');
    expect(classify('./component.vue').kind).toBe('eligible');
    expect(snapshotReads).toBe(0);
  });
});
