import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import { collectTypeScriptSourceTextImports } from '../core/import-analysis/typescript-imports';
import type { SourceFinding } from '../source-check/findings';
import { addResourceModuleProblems } from '../source-check/resource-module-findings';
import { createFixturePathResolver, toPortablePath } from './helpers/path';

type ResourceOptions = Parameters<typeof addResourceModuleProblems>[0];

it('passes complete package-import identities to the physical Node resolver', async () => {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-resource-identity-')),
  );
  const fixturePath = createFixturePathResolver(rootDir);
  const imports = {
    '#foo': './base.svg',
    '#foo/bar': './nested.svg',
    '#foo?raw': './raw.svg',
    '#foo#fragment': './fragment.svg',
  };
  try {
    await writeFile(
      fixturePath('package.json'),
      JSON.stringify({ name: 'fixture', type: 'module', imports }),
    );
    for (const target of Object.values(imports)) {
      await writeFile(fixturePath(target), '<svg />\n');
    }
    const importer = fixturePath('index.ts');
    const sourceText = Object.keys(imports)
      .map((specifier) => `import ${JSON.stringify(specifier)};`)
      .join('\n');
    await writeFile(importer, sourceText);
    const records = collectTypeScriptSourceTextImports({
      filePath: importer,
      sourceText,
    });
    const requireFromFixture = createRequire(importer);
    // This contract starts after classification. It isolates Node's exact-key
    // semantics from checker/loader support for these unusual spellings.
    const evidence = {
      classification: 'resource',
      runtime: { kind: 'missing' },
      type: { kind: 'missing' },
    } as const;
    const typeEvidence = {
      classifyImportRuntime: vi.fn(() => evidence),
      resolveImportEvidence: vi.fn(() => evidence),
    } as unknown as ResourceOptions['typeEvidence'];

    for (const [specifier, target] of Object.entries(imports)) {
      const expectedPath = fixturePath(target);
      expect(toPortablePath(requireFromFixture.resolve(specifier))).toBe(
        expectedPath,
      );
      const findings: SourceFinding[] = [];
      addResourceModuleProblems({
        checkerName: 'tsc',
        config: { rootDir, configPath: fixturePath('limina.config.mjs') },
        findings,
        importRecord: records.find((record) => record.specifier === specifier)!,
        owner: {
          name: 'fixture',
          packageJsonPath: fixturePath('package.json'),
        } as ResourceOptions['owner'],
        project: {
          configPath: fixturePath('tsconfig.json'),
        } as ResourceOptions['project'],
        typeEvidence,
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        code: LIMINA_CHECK_ISSUE_CODES.sourceResourceModuleTypeUndeclared,
        facts: {
          runtimeAuthority: 'package-export',
          runtimeFilePath: expectedPath,
          specifier,
          typeEvidenceKind: 'missing',
        },
      });
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
