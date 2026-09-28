import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import { createImportAnalysisContext } from '../core/import-analysis/runner';
import { collectTypeScriptSourceTextImports } from '../core/import-analysis/typescript-imports';
import { TypeEvidenceCore } from '../core/type-evidence';
import { createWorkspaceSourceBoundary } from '../core/typescript-semantic';
import type { SourceFinding } from '../source-check/findings';
import { addResourceModuleProblems } from '../source-check/resource-module-findings';
import { ResourceResolver } from '../source-check/resource-resolver';
import { resolveFixtureGovernanceRoot } from './helpers/governance-root';
import { createFixturePathResolver, toPortablePath } from './helpers/path';
import { createSemanticRepairFixture } from './helpers/semantic-repair';

type ResourceOptions = Parameters<typeof addResourceModuleProblems>[0];

it.each([false, true])(
  'reports a declaration companion only when it supplies bounded types: admitted=%s',
  async (admitted) => {
    const fixture = await createSemanticRepairFixture({
      'package.json': '{"name":"fixture","type":"module"}',
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'Bundler',
          allowArbitraryExtensions: true,
          types: [],
        },
        files: ['main.ts', ...(admitted ? ['style.d.css.ts'] : [])],
      }),
      'main.ts': "import style from './style.css'; void style;",
      'style.css': '.root {}',
      'style.d.css.ts': 'declare const style: string; export default style;',
    });
    const parsed = fixture.parse();
    const analysis = createImportAnalysisContext({
      projectRootDir: fixture.root,
    });
    const core = new TypeEvidenceCore({
      generation: 0,
      importAnalysis: analysis,
      workspaceSourceBoundaryProvider: () =>
        createWorkspaceSourceBoundary([
          fixture.path('main.ts'),
          fixture.path('style.d.css.ts'),
        ]),
    });
    try {
      const project: ResourceOptions['project'] = {
        analysisGeneration: 0,
        configClosure: [],
        checkerPresets: ['tsc'],
        configPath: fixture.path('tsconfig.json'),
        extensions: [],
        fileNames: parsed.fileNames,
        labels: [],
        labelProblem: null,
        ownedFileNames: parsed.fileNames,
        options: parsed.options,
        references: new Set(),
        resolverConfigPath: fixture.path('tsconfig.json'),
      };
      const record = core
        .getTypeScriptSemanticContext({ checkerName: 'tsc', project })
        .getImportRecords(fixture.path('main.ts'))[0]!;
      const findings: SourceFinding[] = [];
      addResourceModuleProblems({
        resolutionMode: 'import',
        resourceResolver: new ResourceResolver(),
        checkerName: 'tsc',
        config: {
          get governanceRoot() {
            return resolveFixtureGovernanceRoot(this);
          },
          rootDir: fixture.root,
          configPath: fixture.path('limina.config.mjs'),
        },
        findings,
        importRecord: record,
        owner: {
          name: 'fixture',
          packageJsonPath: fixture.path('package.json'),
        } as ResourceOptions['owner'],
        project,
        typeEvidence: core,
      });
      expect(findings).toHaveLength(admitted ? 0 : 1);
      if (!admitted)
        expect(findings[0]).toMatchObject({
          code: LIMINA_CHECK_ISSUE_CODES.sourceResourceModuleTypeUndeclared,
          facts: {
            typeEvidenceKind: 'missing',
            runtimeFilePath: fixture.path('style.css'),
          },
        });
    } finally {
      core.dispose();
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
  'never reinterprets ./foo.ts$suffix as ./foo.ts for a resource finding (ambient=$ambient)',
  async ({ ambient, suffix }) => {
    const fixture = await createSemanticRepairFixture({
      'package.json': '{"name":"fixture","type":"module"}',
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'Bundler',
          types: [],
        },
        files: ['main.ts', ...(ambient ? ['env.d.ts'] : [])],
      }),
      'main.ts': `import value from './foo.ts${suffix}'; void value;`,
      'env.d.ts': `declare module '*${suffix}' { const value: string; export default value; }`,
      // The base file exists; only a stripped specifier could ever reach it.
      'foo.ts': 'export const value = 1;',
      'style.css': '.theme {}',
    });
    const parsed = fixture.parse();
    const core = new TypeEvidenceCore({
      generation: 0,
      importAnalysis: createImportAnalysisContext({
        projectRootDir: fixture.root,
      }),
      workspaceSourceBoundaryProvider: () =>
        createWorkspaceSourceBoundary([
          fixture.path('main.ts'),
          fixture.path('foo.ts'),
        ]),
    });
    try {
      const project: ResourceOptions['project'] = {
        analysisGeneration: 0,
        configClosure: [],
        checkerPresets: ['tsc'],
        configPath: fixture.path('tsconfig.json'),
        extensions: [],
        fileNames: parsed.fileNames,
        labels: [],
        labelProblem: null,
        ownedFileNames: parsed.fileNames,
        options: parsed.options,
        references: new Set(),
        resolverConfigPath: fixture.path('tsconfig.json'),
      };
      const record = core
        .getTypeScriptSemanticContext({ checkerName: 'tsc', project })
        .getImportRecords(fixture.path('main.ts'))[0]!;
      const findings: SourceFinding[] = [];
      addResourceModuleProblems({
        resolutionMode: 'import',
        resourceResolver: new ResourceResolver(),
        checkerName: 'tsc',
        config: {
          get governanceRoot() {
            return resolveFixtureGovernanceRoot(this);
          },
          rootDir: fixture.root,
          configPath: fixture.path('limina.config.mjs'),
        },
        findings,
        importRecord: record,
        owner: {
          name: 'fixture',
          packageJsonPath: fixture.path('package.json'),
        } as ResourceOptions['owner'],
        project,
        typeEvidence: core,
      });
      expect(findings).toEqual([]);
      expect(
        core.classifyImportRuntime({
          checkerName: 'tsc',
          importRecord: record,
          project,
          resolutionMode: 'checker-only',
        }),
      ).toMatchObject({
        classification: 'ordinary-module',
        runtime: {
          kind: 'unsupported',
        },
      });
    } finally {
      core.dispose();
      await fixture.cleanup();
    }
  },
);

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
        resolutionMode: 'import',
        resourceResolver: new ResourceResolver(),
        checkerName: 'tsc',
        config: {
          get governanceRoot() {
            return resolveFixtureGovernanceRoot(this);
          },
          rootDir,
          configPath: fixturePath('limina.config.mjs'),
        },
        findings,
        importRecord: records.find((record) => record.specifier === specifier)!,
        owner: {
          name: 'fixture',
          packageJsonPath: fixturePath('package.json'),
        } as ResourceOptions['owner'],
        project: {
          configPath: fixturePath('tsconfig.json'),
          options: {},
        } as ResourceOptions['project'],
        typeEvidence,
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        code: LIMINA_CHECK_ISSUE_CODES.sourceResourceModuleTypeUndeclared,
        facts: {
          runtimeAuthority:
            specifier === '#foo' || specifier === '#foo/bar'
              ? 'oxc'
              : 'package-export',
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
