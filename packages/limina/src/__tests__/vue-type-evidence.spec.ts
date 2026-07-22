import { parseCheckerProjectConfigForContext } from '#checkers';
import { createImportAnalysisContext } from '#core/import-analysis/runner';
import type { ProjectInfo } from '#core/import-graph/context';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TypeEvidenceCore } from '../core/type-evidence';
import { isSupportedVueTypeEvidenceVersionTuple } from '../core/type-evidence/vue-provider';
import {
  type AnalysisMetricAggregate,
  createProfilingMetricsRecorder,
} from '../profiling/metrics';

const requireFromTest = createRequire(import.meta.url);

function metricCount(
  snapshot: readonly AnalysisMetricAggregate[],
  name: AnalysisMetricAggregate['name'],
): number {
  return snapshot
    .filter((metric) => metric.name === name)
    .reduce((total, metric) => total + metric.count, 0);
}

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

async function linkPackage(
  rootDir: string,
  packageName: string,
): Promise<void> {
  const manifestPath = requireFromTest.resolve(`${packageName}/package.json`);
  const packageDirectory = path.dirname(manifestPath);
  const targetPath = path.join(
    rootDir,
    'node_modules',
    ...packageName.split('/'),
  );

  await mkdir(path.dirname(targetPath), { recursive: true });
  await symlink(packageDirectory, targetPath, 'dir');
}

async function createFixture(files: Record<string, string>): Promise<{
  cleanup: () => Promise<void>;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-vue-type-evidence-')),
  );

  for (const [relativePath, text] of Object.entries({
    'node_modules/vue/package.json':
      '{"name":"vue","version":"3.5.0","types":"index.d.ts"}\n',
    'node_modules/vue/index.d.ts': 'export {};\n',
    'package.json': '{"name":"fixture","private":true}\n',
    ...files,
  })) {
    await writeText(path.join(rootDir, relativePath), text);
  }

  return {
    cleanup: async () => {
      await rm(rootDir, { force: true, recursive: true });
    },
    rootDir,
  };
}

async function linkVueToolchain(rootDir: string): Promise<void> {
  await linkPackage(rootDir, 'vue-tsc');
}

function createVueProject(
  rootDir: string,
): Pick<
  ProjectInfo,
  | 'checkerPresets'
  | 'configPath'
  | 'extensions'
  | 'fileNames'
  | 'options'
  | 'resolverConfigPath'
> {
  const configPath = path.join(rootDir, 'tsconfig.json');
  const parsed = parseCheckerProjectConfigForContext({
    configPath,
    context: {
      checkerPresets: ['vue-tsc'],
      extensions: ['.vue'],
    },
    projectRootDir: rootDir,
  });

  return {
    checkerPresets: ['vue-tsc'],
    configPath,
    extensions: parsed.extensions,
    fileNames: parsed.fileNames,
    options: parsed.options,
    resolverConfigPath: configPath,
  };
}

function tsconfig(types: string[] = []): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        allowArbitraryExtensions: true,
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        target: 'ES2023',
        types,
      },
      include: ['src/**/*'],
    },
    null,
    2,
  )}\n`;
}

describe('Vue resource type evidence', () => {
  it('accepts only the approved version tuple', () => {
    expect(
      isSupportedVueTypeEvidenceVersionTuple({
        languageCore: '3.2.4',
        typeScript: '6.0.3',
        volarTypeScript: '2.4.27',
        vueTsc: '3.2.4',
      }),
    ).toBe(true);
    expect(
      isSupportedVueTypeEvidenceVersionTuple({
        languageCore: '3.3.0',
        typeScript: '6.0.3',
        volarTypeScript: '2.5.0',
        vueTsc: '3.3.0',
      }),
    ).toBe(false);
    expect(
      isSupportedVueTypeEvidenceVersionTuple({
        languageCore: '3.2.6',
        typeScript: '5.9.3',
        volarTypeScript: '2.4.28',
        vueTsc: '3.2.6',
      }),
    ).toBe(true);
  });

  it('maps script-setup duplicates and query imports to canonical ambient symbols', async () => {
    const fixture = await createFixture({
      'src/App.vue': [
        '<template><div>資源😀</div></template>',
        '<script setup lang="ts">',
        "import './style.css';",
        "import './style.css';",
        "import './data.txt?raw';",
        '</script>',
        '',
      ].join('\r\n'),
      'node_modules/vite/client.d.ts': [
        "declare module '*.css';",
        "declare module '*?raw';",
        '',
      ].join('\n'),
      'node_modules/vite/package.json': '{"name":"vite","version":"1.0.0"}\n',
      'src/data.txt': 'data\n',
      'src/style.css': '.root {}\n',
      'tsconfig.json': tsconfig(['vite/client']),
    });
    let core: TypeEvidenceCore | undefined;

    try {
      await linkVueToolchain(fixture.rootDir);
      const project = createVueProject(fixture.rootDir);
      const filePath = path.join(fixture.rootDir, 'src/App.vue');
      const metrics = createProfilingMetricsRecorder();
      const importAnalysis = createImportAnalysisContext({
        metrics,
        projectRootDir: fixture.rootDir,
      });
      const imports = importAnalysis.collectImportsFromFile(
        filePath,
        fixture.rootDir,
      );
      core = new TypeEvidenceCore({
        generation: 0,
        importAnalysis,
        metrics,
      });
      const evidence = imports.map((importRecord) =>
        core!.resolveImportEvidence({
          checkerName: 'vue',
          importRecord,
          project,
        }),
      );

      expect(evidence.map((item) => item.type.kind)).toEqual([
        'ambient',
        'ambient',
        'ambient',
      ]);
      expect(
        evidence.map((item) =>
          item.type.kind === 'ambient' ? item.type.modulePattern : null,
        ),
      ).toEqual(['*.css', '*.css', '*?raw']);
      expect(core.cache.typeEvidenceProviderCache.size).toBe(1);
      expect(core.cache.programCache.size).toBe(1);
      expect(core.cache.importTypeEvidenceCache.size).toBe(3);
      const metricSnapshot = metrics.snapshot();
      expect(metricCount(metricSnapshot, 'vue-program-create')).toBe(1);
      expect(metricCount(metricSnapshot, 'typescript-program-create')).toBe(0);
      expect(metricCount(metricSnapshot, 'type-evidence-provider-create')).toBe(
        1,
      );
      expect(metricCount(metricSnapshot, 'type-evidence-provider-hit')).toBe(2);
      expect(metricCount(metricSnapshot, 'resource-import-count')).toBe(3);
      expect(metricCount(metricSnapshot, 'affected-source-config-count')).toBe(
        1,
      );
    } finally {
      core?.dispose();
      await fixture.cleanup();
    }
  });

  it('maps classic script imports through a local ambient declaration', async () => {
    const fixture = await createFixture({
      'src/App.vue': [
        '<script lang="ts">',
        "import './style.css';",
        'export default {};',
        '</script>',
        '',
      ].join('\n'),
      'src/assets.d.ts': "declare module '*.css';\n",
      'src/style.css': '.root {}\n',
      'tsconfig.json': tsconfig(),
    });
    let core: TypeEvidenceCore | undefined;

    try {
      await linkVueToolchain(fixture.rootDir);
      const project = createVueProject(fixture.rootDir);
      const filePath = path.join(fixture.rootDir, 'src/App.vue');
      const importAnalysis = createImportAnalysisContext({
        projectRootDir: fixture.rootDir,
      });
      const [importRecord] = importAnalysis.collectImportsFromFile(
        filePath,
        fixture.rootDir,
      );
      core = new TypeEvidenceCore({ generation: 0, importAnalysis });

      expect(
        core.resolveImportEvidence({
          checkerName: 'vue',
          importRecord: importRecord!,
          project,
        }).type.kind,
      ).toBe('ambient');
    } finally {
      core?.dispose();
      await fixture.cleanup();
    }
  });

  it('maps native TypeScript imports through the current Vue Language Service Program', async () => {
    const fixture = await createFixture({
      'src/assets.d.ts': "declare module '*.css';\n",
      'src/index.ts': "import './style.css';\n",
      'src/style.css': '.root {}\n',
      'tsconfig.json': tsconfig(),
    });
    let core: TypeEvidenceCore | undefined;

    try {
      await linkVueToolchain(fixture.rootDir);
      const project = createVueProject(fixture.rootDir);
      const filePath = path.join(fixture.rootDir, 'src/index.ts');
      const metrics = createProfilingMetricsRecorder();
      const importAnalysis = createImportAnalysisContext({
        metrics,
        projectRootDir: fixture.rootDir,
      });
      const [importRecord] = importAnalysis.collectImportsFromFile(
        filePath,
        fixture.rootDir,
      );
      core = new TypeEvidenceCore({
        generation: 0,
        importAnalysis,
        metrics,
      });

      expect(
        core.resolveImportEvidence({
          checkerName: 'vue',
          importRecord: importRecord!,
          project,
        }).type.kind,
      ).toBe('ambient');
      expect(metricCount(metrics.snapshot(), 'vue-program-create')).toBe(1);
      expect(metricCount(metrics.snapshot(), 'typescript-program-create')).toBe(
        0,
      );
    } finally {
      core?.dispose();
      await fixture.cleanup();
    }
  });

  it('returns unsupported-checker without a plain Program when vue-tsc is unavailable', async () => {
    const fixture = await createFixture({
      'src/App.vue':
        '<script setup lang="ts">import \'./style.css\';</script>\n',
      'src/style.css': '.root {}\n',
      'tsconfig.json': tsconfig(),
    });
    const filePath = path.join(fixture.rootDir, 'src/App.vue');
    const importAnalysis = createImportAnalysisContext({
      projectRootDir: fixture.rootDir,
    });
    const [importRecord] = importAnalysis.collectImportsFromFile(
      filePath,
      fixture.rootDir,
    );
    const core = new TypeEvidenceCore({ generation: 0, importAnalysis });

    try {
      const evidence = core.resolveImportEvidence({
        checkerName: 'vue',
        importRecord: importRecord!,
        project: {
          checkerPresets: ['vue-tsc'],
          configPath: path.join(fixture.rootDir, 'tsconfig.json'),
          extensions: ['.ts', '.vue'],
          fileNames: [filePath],
          options: {},
          resolverConfigPath: path.join(fixture.rootDir, 'tsconfig.json'),
        },
      });

      expect(evidence.type).toMatchObject({ kind: 'unsupported-checker' });
      expect(core.cache.programCache.size).toBe(0);
    } finally {
      core.dispose();
      await fixture.cleanup();
    }
  });
});
