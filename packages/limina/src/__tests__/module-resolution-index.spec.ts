import {
  createImportAnalysisContext,
  type ImportResolveContextFields,
} from '#core/import-analysis/runner';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AnalysisMetricAggregate,
  createProfilingMetricsRecorder,
} from '../profiling/metrics';
import { toPortablePath } from './helpers/path';

async function writeText(
  rootDir: string,
  relativePath: string,
  text: string,
): Promise<string> {
  const filePath = path.join(rootDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
  return filePath;
}

function metricCount(
  snapshot: readonly AnalysisMetricAggregate[],
  name: AnalysisMetricAggregate['name'],
  kind?: string,
): number {
  return snapshot
    .filter(
      (metric) =>
        metric.name === name && (kind === undefined || metric.kind === kind),
    )
    .reduce((total, metric) => total + metric.count, 0);
}

describe('generation-scoped module resolution index', () => {
  let configPath: string;
  let containingFile: string;
  let rootDir: string;
  let targetPath: string;

  const resolverContext = (
    overrides: Partial<ImportResolveContextFields> = {},
  ): ImportResolveContextFields => ({
    checkerPresets: [],
    configPath,
    extensions: ['.ts'],
    resolverConfigPath: configPath,
    ...overrides,
  });

  beforeEach(async () => {
    rootDir = await realpath(
      await mkdtemp(path.join(tmpdir(), 'limina-resolution-index-')),
    );
    configPath = await writeText(
      rootDir,
      'tsconfig.json',
      JSON.stringify({ compilerOptions: {} }),
    );
    containingFile = await writeText(
      rootDir,
      'src/index.ts',
      "import './target';\n",
    );
    targetPath = await writeText(
      rootDir,
      'src/target.ts',
      'export const target = true;\n',
    );
  });

  afterEach(async () => {
    await rm(rootDir, { force: true, recursive: true });
  });

  it('caches successful and null TypeScript results and Oxc results by cell', () => {
    const metrics = createProfilingMetricsRecorder();
    const context = createImportAnalysisContext({ metrics });
    const firstTypeScriptResult = context.resolveTypeScriptImport(
      './target',
      containingFile,
      {},
      resolverContext(),
    );

    expect(firstTypeScriptResult?.resolvedFileName).toBe(
      toPortablePath(targetPath),
    );
    if (firstTypeScriptResult) {
      firstTypeScriptResult.resolvedFileName = '/mutated-by-caller.ts';
    }
    expect(
      context.resolveTypeScriptImport(
        './target',
        containingFile,
        {},
        resolverContext(),
      )?.resolvedFileName,
    ).toBe(toPortablePath(targetPath));

    for (let request = 0; request < 2; request += 1) {
      expect(
        context.resolveTypeScriptImport(
          'missing-typescript-package',
          containingFile,
          {},
          resolverContext(),
        ),
      ).toBeNull();
      expect(
        context.resolveOxcImport(
          'missing-oxc-package',
          containingFile,
          {},
          resolverContext(),
        ),
      ).toBeNull();
    }

    const snapshot = metrics.snapshot();
    expect(metricCount(snapshot, 'typescript-resolution')).toBe(2);
    expect(metricCount(snapshot, 'oxc-resolution')).toBe(1);
    expect(
      metricCount(snapshot, 'module-resolution-index-miss', 'typescript'),
    ).toBe(2);
    expect(
      metricCount(snapshot, 'module-resolution-index-hit', 'typescript'),
    ).toBe(2);
    expect(metricCount(snapshot, 'module-resolution-index-miss', 'oxc')).toBe(
      1,
    );
    expect(metricCount(snapshot, 'module-resolution-index-hit', 'oxc')).toBe(1);
  });

  it('fills and reuses pair cells independently in every public call order', () => {
    const pairFirstMetrics = createProfilingMetricsRecorder();
    const pairFirst = createImportAnalysisContext({
      metrics: pairFirstMetrics,
    });
    const pair = pairFirst.resolveModulePair(
      './target',
      containingFile,
      {},
      resolverContext(),
    );

    expect(pair.typescript?.resolvedFileName).toBe(toPortablePath(targetPath));
    expect(pair.oxc).toBe(toPortablePath(targetPath));
    expect(
      pairFirst.resolveTypeScriptImport(
        './target',
        containingFile,
        {},
        resolverContext(),
      ),
    ).toEqual(pair.typescript);
    expect(
      pairFirst.resolveOxcImport(
        './target',
        containingFile,
        {},
        resolverContext(),
      ),
    ).toBe(pair.oxc);

    const pairFirstSnapshot = pairFirstMetrics.snapshot();
    expect(metricCount(pairFirstSnapshot, 'module-resolution-request')).toBe(4);
    expect(metricCount(pairFirstSnapshot, 'typescript-resolution')).toBe(1);
    expect(metricCount(pairFirstSnapshot, 'oxc-resolution')).toBe(1);
    expect(metricCount(pairFirstSnapshot, 'module-resolution-index-miss')).toBe(
      2,
    );
    expect(metricCount(pairFirstSnapshot, 'module-resolution-index-hit')).toBe(
      2,
    );

    const typeScriptFirstMetrics = createProfilingMetricsRecorder();
    const typeScriptFirst = createImportAnalysisContext({
      metrics: typeScriptFirstMetrics,
    });
    typeScriptFirst.resolveTypeScriptImport(
      './target',
      containingFile,
      {},
      resolverContext(),
    );
    typeScriptFirst.resolveModulePair(
      './target',
      containingFile,
      {},
      resolverContext(),
    );
    const typeScriptFirstSnapshot = typeScriptFirstMetrics.snapshot();
    expect(metricCount(typeScriptFirstSnapshot, 'typescript-resolution')).toBe(
      1,
    );
    expect(metricCount(typeScriptFirstSnapshot, 'oxc-resolution')).toBe(1);
    expect(
      metricCount(
        typeScriptFirstSnapshot,
        'module-resolution-index-hit',
        'typescript',
      ),
    ).toBe(1);
    expect(
      metricCount(
        typeScriptFirstSnapshot,
        'module-resolution-index-miss',
        'oxc',
      ),
    ).toBe(1);

    const oxcFirstMetrics = createProfilingMetricsRecorder();
    const oxcFirst = createImportAnalysisContext({ metrics: oxcFirstMetrics });
    oxcFirst.resolveOxcImport(
      './target',
      containingFile,
      {},
      resolverContext(),
    );
    oxcFirst.resolveModulePair(
      './target',
      containingFile,
      {},
      resolverContext(),
    );
    const oxcFirstSnapshot = oxcFirstMetrics.snapshot();
    expect(metricCount(oxcFirstSnapshot, 'typescript-resolution')).toBe(1);
    expect(metricCount(oxcFirstSnapshot, 'oxc-resolution')).toBe(1);
    expect(
      metricCount(oxcFirstSnapshot, 'module-resolution-index-hit', 'oxc'),
    ).toBe(1);
    expect(
      metricCount(
        oxcFirstSnapshot,
        'module-resolution-index-miss',
        'typescript',
      ),
    ).toBe(1);
  });

  it('shares only resolver cells that the internal-import policy computed', async () => {
    const typeOnlyDeclaration = await writeText(
      rootDir,
      'node_modules/type-only-package/types.d.ts',
      'export declare const value: true;\n',
    );
    await writeText(
      rootDir,
      'node_modules/type-only-package/package.json',
      JSON.stringify({
        name: 'type-only-package',
        types: './types.d.ts',
      }),
    );

    const internalFirstMetrics = createProfilingMetricsRecorder();
    const internalFirst = createImportAnalysisContext({
      metrics: internalFirstMetrics,
    });
    expect(
      internalFirst.resolveInternalImport(
        'type-only-package',
        containingFile,
        {},
        resolverContext(),
      ),
    ).toBe(toPortablePath(typeOnlyDeclaration));
    internalFirst.resolveModulePair(
      'type-only-package',
      containingFile,
      {},
      resolverContext(),
    );

    const internalFirstSnapshot = internalFirstMetrics.snapshot();
    expect(metricCount(internalFirstSnapshot, 'typescript-resolution')).toBe(1);
    expect(metricCount(internalFirstSnapshot, 'oxc-resolution')).toBe(1);
    expect(
      metricCount(
        internalFirstSnapshot,
        'module-resolution-index-hit',
        'typescript',
      ),
    ).toBe(1);
    expect(
      metricCount(internalFirstSnapshot, 'module-resolution-index-hit', 'oxc'),
    ).toBe(1);

    const shortCircuitMetrics = createProfilingMetricsRecorder();
    const shortCircuitFirst = createImportAnalysisContext({
      metrics: shortCircuitMetrics,
    });
    expect(
      shortCircuitFirst.resolveInternalImport(
        './target',
        containingFile,
        {},
        resolverContext(),
      ),
    ).toBe(toPortablePath(targetPath));
    expect(metricCount(shortCircuitMetrics.snapshot(), 'oxc-resolution')).toBe(
      0,
    );
    expect(
      metricCount(shortCircuitMetrics.snapshot(), 'typescript-resolution'),
    ).toBe(0);
    shortCircuitFirst.resolveModulePair(
      './target',
      containingFile,
      {},
      resolverContext(),
    );
    const shortCircuitSnapshot = shortCircuitMetrics.snapshot();
    expect(metricCount(shortCircuitSnapshot, 'typescript-resolution')).toBe(1);
    expect(metricCount(shortCircuitSnapshot, 'oxc-resolution')).toBe(1);
    expect(
      metricCount(shortCircuitSnapshot, 'module-resolution-index-hit'),
    ).toBe(0);
  });

  it('lets source internal-import reuse both raw cells after a graph pair', async () => {
    const typeOnlyDeclaration = await writeText(
      rootDir,
      'node_modules/graph-first-package/types.d.ts',
      'export declare const value: true;\n',
    );
    await writeText(
      rootDir,
      'node_modules/graph-first-package/package.json',
      JSON.stringify({
        name: 'graph-first-package',
        types: './types.d.ts',
      }),
    );
    const metrics = createProfilingMetricsRecorder();
    const context = createImportAnalysisContext({ metrics });

    const pair = context.resolveModulePair(
      'graph-first-package',
      containingFile,
      {},
      resolverContext(),
    );
    expect(pair.oxc).toBeNull();
    expect(pair.typescript?.resolvedFileName).toBe(
      toPortablePath(typeOnlyDeclaration),
    );
    expect(
      context.resolveInternalImport(
        'graph-first-package',
        containingFile,
        {},
        resolverContext(),
      ),
    ).toBe(toPortablePath(typeOnlyDeclaration));

    const snapshot = metrics.snapshot();
    expect(metricCount(snapshot, 'typescript-resolution')).toBe(1);
    expect(metricCount(snapshot, 'oxc-resolution')).toBe(1);
    expect(
      metricCount(snapshot, 'module-resolution-index-hit', 'typescript'),
    ).toBe(1);
    expect(metricCount(snapshot, 'module-resolution-index-hit', 'oxc')).toBe(1);
    expect(
      metricCount(snapshot, 'module-resolution-index-miss', 'internal-import'),
    ).toBe(1);
  });

  it('keeps the complete conservative request identity generation-local', async () => {
    const alternateConfigPath = await writeText(
      rootDir,
      'configs/alternate.json',
      JSON.stringify({ compilerOptions: {} }),
    );
    const alternateContainingFile = await writeText(
      rootDir,
      'other/index.ts',
      'export {};\n',
    );
    const metrics = createProfilingMetricsRecorder();
    const context = createImportAnalysisContext({ metrics });
    const baseOptions: ts.CompilerOptions = {};
    const requests: {
      compilerOptions?: ts.CompilerOptions;
      containingFile?: string;
      context?: ImportResolveContextFields;
      specifier?: string;
    }[] = [
      {},
      { containingFile: `${rootDir}/src/./index.ts` },
      { containingFile: alternateContainingFile },
      { specifier: 'another-missing-package' },
      {
        context: resolverContext({
          configPath: alternateConfigPath,
          resolverConfigPath: alternateConfigPath,
        }),
      },
      {
        context: resolverContext({
          resolverConfigPath: alternateConfigPath,
        }),
      },
      { compilerOptions: { preserveSymlinks: true } },
      { context: resolverContext({ extensions: ['.ts', '.vue'] }) },
      { compilerOptions: { resolveJsonModule: true } },
    ];

    for (const request of requests) {
      expect(
        context.resolveTypeScriptImport(
          request.specifier ?? 'missing-package',
          request.containingFile ?? containingFile,
          request.compilerOptions ?? baseOptions,
          request.context ?? resolverContext(),
        ),
      ).toBeNull();
    }

    createImportAnalysisContext({ metrics }).resolveTypeScriptImport(
      'missing-package',
      containingFile,
      baseOptions,
      resolverContext(),
    );

    const snapshot = metrics.snapshot();
    expect(metricCount(snapshot, 'typescript-resolution')).toBe(9);
    expect(
      metricCount(snapshot, 'module-resolution-index-miss', 'typescript'),
    ).toBe(9);
    expect(
      metricCount(snapshot, 'module-resolution-index-hit', 'typescript'),
    ).toBe(1);
  });

  it('preserves internal-import short-circuit and fallback precedence', async () => {
    const earlyMetrics = createProfilingMetricsRecorder();
    const earlyContext = createImportAnalysisContext({ metrics: earlyMetrics });
    const pathMappedOptions: ts.CompilerOptions = {
      baseUrl: rootDir,
      paths: {
        '@target': ['src/target'],
      },
    };

    expect(
      earlyContext.resolveInternalImport(
        './target',
        containingFile,
        {},
        resolverContext(),
      ),
    ).toBe(toPortablePath(targetPath));
    expect(
      earlyContext.resolveInternalImport(
        '@target',
        containingFile,
        pathMappedOptions,
        resolverContext(),
      ),
    ).toBe(toPortablePath(targetPath));
    expect(
      earlyContext.resolveInternalImport(
        'target',
        containingFile,
        { baseUrl: path.join(rootDir, 'src') },
        resolverContext(),
      ),
    ).toBe(toPortablePath(targetPath));

    const earlySnapshot = earlyMetrics.snapshot();
    expect(metricCount(earlySnapshot, 'oxc-resolution')).toBe(0);
    expect(metricCount(earlySnapshot, 'typescript-resolution')).toBe(0);

    const nativeTargetPath = await writeText(
      rootDir,
      'src/platform.native.ts',
      'export const platform = true;\n',
    );
    const typeScriptOnlyMetrics = createProfilingMetricsRecorder();
    const typeScriptOnlyContext = createImportAnalysisContext({
      metrics: typeScriptOnlyMetrics,
    });
    expect(
      typeScriptOnlyContext.resolveInternalImport(
        './platform',
        containingFile,
        { moduleSuffixes: ['.native', ''] },
        resolverContext(),
      ),
    ).toBe(toPortablePath(nativeTargetPath));
    const typeScriptOnlySnapshot = typeScriptOnlyMetrics.snapshot();
    expect(metricCount(typeScriptOnlySnapshot, 'typescript-resolution')).toBe(
      1,
    );
    expect(metricCount(typeScriptOnlySnapshot, 'oxc-resolution')).toBe(0);

    const runtimeEntryPath = await writeText(
      rootDir,
      'node_modules/runtime-package/index.js',
      'export const runtime = true;\n',
    );
    await writeText(
      rootDir,
      'node_modules/runtime-package/package.json',
      JSON.stringify({ main: './index.js', name: 'runtime-package' }),
    );
    const oxcFallbackMetrics = createProfilingMetricsRecorder();
    const oxcFallbackContext = createImportAnalysisContext({
      metrics: oxcFallbackMetrics,
    });
    expect(
      oxcFallbackContext.resolveInternalImport(
        'runtime-package',
        containingFile,
        {},
        resolverContext({ extensions: ['.ts', '.js'] }),
      ),
    ).toBe(toPortablePath(runtimeEntryPath));
    const oxcFallbackSnapshot = oxcFallbackMetrics.snapshot();
    expect(metricCount(oxcFallbackSnapshot, 'oxc-resolution')).toBe(1);
    expect(metricCount(oxcFallbackSnapshot, 'typescript-resolution')).toBe(0);

    const declarationPath = await writeText(
      rootDir,
      'node_modules/typescript-fallback/types.d.ts',
      'export declare const typeOnly: true;\n',
    );
    await writeText(
      rootDir,
      'node_modules/typescript-fallback/package.json',
      JSON.stringify({
        name: 'typescript-fallback',
        types: './types.d.ts',
      }),
    );
    const typeScriptFallbackMetrics = createProfilingMetricsRecorder();
    const typeScriptFallbackContext = createImportAnalysisContext({
      metrics: typeScriptFallbackMetrics,
    });
    expect(
      typeScriptFallbackContext.resolveInternalImport(
        'typescript-fallback',
        containingFile,
        {},
        resolverContext(),
      ),
    ).toBe(toPortablePath(declarationPath));
    const typeScriptFallbackSnapshot = typeScriptFallbackMetrics.snapshot();
    expect(metricCount(typeScriptFallbackSnapshot, 'oxc-resolution')).toBe(1);
    expect(
      metricCount(typeScriptFallbackSnapshot, 'typescript-resolution'),
    ).toBe(1);
  });
});
