import { execFileSync } from 'node:child_process';
import {
  cp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createCheckerFailureIssues } from '../commands/checker-failure-issues';
import { loadConfig } from '../config/loader';
import { AnalysisInputDriftError } from '../core/analysis-cache/contracts';
import { identifier } from '../domain/shared/identifiers';
import { LiminaPreflightManager } from '../preflight/manager';
import { ExecutionAdmission } from '../typecheck/admission/execution-admission';
import type { ExecutionPermit } from '../typecheck/admission/types';
import { executeCheckerBuildTargets } from '../typecheck/checker/build-execution';
import { executeAuthorizedTypecheck } from '../typecheck/checker/typecheck-execution';
import {
  createCheckerTarget,
  createFrameworkCheckerTargets,
} from '../typecheck/targets';
import { withFixtureGovernanceRoot } from './helpers/governance-root';
import { createSemanticRepairFixture } from './helpers/semantic-repair';

async function frameworkInputFixture(hasConfig: boolean) {
  const f = await createSemanticRepairFixture({
    'package.json':
      '{"name":"framework-inputs","private":true,"type":"module"}',
    'pnpm-workspace.yaml': 'packages:\n - a\n - b\n - c\n - d\n',
    'limina.config.mjs': 'export default {};',
    'a/package.json':
      '{"name":"a","private":true,"type":"module","devDependencies":{"svelte":"4.0.0","svelte-check":"4.0.0"}}',
    'a/tsconfig.json': JSON.stringify({
      compilerOptions: {
        noEmit: true,
        module: 'ESNext',
        moduleResolution: 'bundler',
        target: 'ES2023',
        strict: true,
        skipLibCheck: true,
        types: [],
      },
      include: ['**/*'],
    }),
    'a/App.svelte':
      '<script lang="ts">import {value} from "../b/value.js"; const n:number=value;</script><p>{n}</p>',
    'b/value.ts': 'export { value } from "../c/value.js";',
    'b/tsconfig.json':
      '{"compilerOptions":{"module":"ESNext","moduleResolution":"bundler","noEmit":true,"types":[]},"files":["value.ts"]}',
    'c/tsconfig.json':
      '{"compilerOptions":{"module":"ESNext","moduleResolution":"bundler","noEmit":true,"types":[]},"files":["value.ts"]}',
    'd/tsconfig.json':
      '{"compilerOptions":{"module":"ESNext","moduleResolution":"bundler","noEmit":true,"types":[]},"files":["value.ts"]}',
    'c/value.ts': 'export const value=1;',
    'd/value.ts': 'export const unrelated=1;',
    'settings.cjs': 'module.exports = {compilerOptions:{dev:true}};',
    ...(hasConfig && {
      'a/svelte.config.cjs': 'module.exports = require("../settings.cjs");',
    }),
  });
  const require = createRequire(import.meta.url);
  await mkdir(f.path('a/node_modules'), { recursive: true });
  for (const [name, installed] of [
    ['svelte', 'svelte-v4-min'],
    ['svelte-check', 'svelte-check-v4-min'],
    ['svelte2tsx', 'svelte2tsx'],
    ['typescript', 'typescript'],
  ])
    await symlink(
      path.dirname(require.resolve(`${installed}/package.json`)),
      f.path(`a/node_modules/${name}`),
      'junction',
    );
  const config = withFixtureGovernanceRoot({
    rootDir: f.root,
    configPath: f.path('limina.config.mjs'),
    cache: false,
    scope: {
      checkers: {
        'svelte-check': { include: ['a/tsconfig.json'] },
        tsc: {
          include: ['b/tsconfig.json', 'c/tsconfig.json', 'd/tsconfig.json'],
        },
      },
    },
  });
  const preflight = new LiminaPreflightManager({ config });
  return { f, preflight };
}

it.each(['transitive', 'unrelated', 'new-config', 'config-import'])(
  'binds framework execution to consumed inputs (%s)',
  async (change) => {
    const { f, preflight } = await frameworkInputFixture(
      change === 'config-import',
    );
    try {
      const graph = (await preflight.ensureGeneratedArtifactsMaterialized())
        .graph;
      const targets = createFrameworkCheckerTargets({
        generatedGraph: graph,
        workspaceRootDir: f.root,
      });
      expect(targets).toHaveLength(1);
      const admission = new ExecutionAdmission(preflight, graph, targets);
      const target = targets[0]!;
      const initial = await executeAuthorizedTypecheck(
        { admission },
        target,
        () => ({ configPath: target.configPath, status: 0 }),
      );
      expect(initial.status, JSON.stringify(initial)).toBe(0);
      const file =
        change === 'config-import'
          ? 'settings.cjs'
          : change === 'new-config'
            ? 'a/svelte.config.mjs'
            : change === 'transitive'
              ? 'c/value.ts'
              : 'd/value.ts';
      await writeFile(
        f.path(file),
        /\.[cm]js$/u.test(file)
          ? 'module.exports = {};'
          : 'export const value="changed";',
      );
      let isStarted = false;
      const result = await executeAuthorizedTypecheck(
        { admission },
        target,
        () => {
          isStarted = true;
          return { configPath: target.configPath, status: 0 };
        },
      );
      expect(isStarted).toBe(change === 'unrelated');
      expect(result.status).toBe(
        change === 'unrelated' ? 0 : 'admission-rejected',
      );
    } finally {
      preflight.dispose();
      await f.cleanup();
    }
  },
);

// A real Node loader and two framework generations can exceed 30s on Windows.
it('retains live CommonJS configuration proof through managed refresh in Node', async () => {
  const { f, preflight } = await frameworkInputFixture(true);
  const moduleURL = (file: string) =>
    JSON.stringify(new URL(`../${file}.ts`, import.meta.url).href);
  try {
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
        '--input-type=module',
        '--eval',
        `
import { writeFile } from 'node:fs/promises';
import { LiminaPreflightManager } from ${moduleURL('preflight/manager')};
import { createFrameworkCheckerTargets } from ${moduleURL('typecheck/targets')};
import { ExecutionAdmission } from ${moduleURL('typecheck/admission/execution-admission')};
import { executeAuthorizedTypecheck } from ${moduleURL('typecheck/checker/typecheck-execution')};
import { withFixtureGovernanceRoot } from ${moduleURL('__tests__/helpers/governance-root')};
const root = ${JSON.stringify(f.root)};
const config = withFixtureGovernanceRoot({rootDir: root, configPath: root + '/limina.config.mjs', cache: false, scope: {checkers: {'svelte-check': {include: ['a/tsconfig.json']}}}});
const manager = new LiminaPreflightManager({config: config});
let starts = 0;
async function execute(graph) {
  const targets = createFrameworkCheckerTargets({generatedGraph: graph, workspaceRootDir: root});
  const admission = new ExecutionAdmission(manager, graph, targets);
  return executeAuthorizedTypecheck({admission: admission}, targets[0], () => {
    starts++;
    return {configPath: targets[0].configPath, status: 0};
  });
}
try {
  await manager.ensureGeneratedArtifactsMaterialized();
  const refreshed = (await manager.refreshAfterManagedOutputs()).graph;
  const afterRefresh = await execute(refreshed);
  await writeFile(root + '/settings.cjs', 'module.exports = {compilerOptions:{dev:false}};');
  const changed = await execute(refreshed);
console.log(JSON.stringify({statuses: [afterRefresh.status, changed.status], starts, afterRefresh}));
} finally { manager.dispose(); }
`,
      ],
      { encoding: 'utf8' },
    );
    const { afterRefresh, ...result } = JSON.parse(
      output.trim().split('\n').at(-1)!,
    );
    expect(result, JSON.stringify(afterRefresh)).toEqual({
      statuses: [0, 'admission-rejected'],
      starts: 1,
    });
  } finally {
    preflight.dispose();
    await f.cleanup();
  }
}, 60_000);

it.each([
  { cacheMode: 'disabled', change: 'content' },
  { cacheMode: 'cold', change: 'content' },
  { cacheMode: 'disabled', change: 'binding' },
  { cacheMode: 'cold', change: 'binding' },
])(
  'rejects Vue declaration $change drift with $cacheMode caching',
  async ({ cacheMode, change }) => {
    const f = await createSemanticRepairFixture({
      'package.json': '{"name":"vue-inputs","private":true,"type":"module"}',
      'pnpm-workspace.yaml': 'packages:\n - a\n - b\n - d\n',
      'limina.config.mjs': `export default ${JSON.stringify({
        cache: cacheMode !== 'disabled',
        scope: { checkers: { 'vue-tsc': { include: ['a/tsconfig.json'] } } },
      })};`,
      'a/package.json': '{"name":"a","private":true,"type":"module"}',
      'a/tsconfig.json':
        '{"compilerOptions":{"module":"NodeNext","types":[],"strict":true},"files":["index.ts"]}',
      'a/index.ts':
        'import {value} from "../b/dist/index.js"; export const a:number=value;',
      'b/content/index.d.ts': 'export declare const value:number;',
      'd/unrelated.ts': 'export const unrelated=1;',
    });
    for (const alias of ['first', 'second'])
      await symlink(f.path('b/content'), f.path(`b/${alias}`), 'junction');
    await symlink(f.path('b/first'), f.path('b/dist'), 'junction');
    const require = createRequire(import.meta.url);
    await mkdir(f.path('node_modules'), { recursive: true });
    for (const name of ['vue-tsc', 'typescript'])
      await symlink(
        path.dirname(require.resolve(`${name}/package.json`)),
        f.path(`node_modules/${name}`),
        'junction',
      );
    const config = await loadConfig({
      configPath: f.path('limina.config.mjs'),
    });
    const preflight = new LiminaPreflightManager({ config });
    try {
      const graph = (await preflight.ensureGeneratedArtifactsMaterialized())
        .graph;
      const target = createCheckerTarget({
        checker: graph.checkers[0]!,
        configPath: graph.checkerEntries.get('vue-tsc')!,
        executionKind: 'build',
        projectRootDir: f.root,
      });
      const admission = new ExecutionAdmission(preflight, graph, [target]);
      let starts = 0;
      const run = () =>
        executeAuthorizedTypecheck({ admission }, target, () => {
          starts++;
          return { configPath: target.configPath, status: 0 };
        });
      await writeFile(f.path('d/unrelated.ts'), 'export const unrelated=2;');
      const initial = await run();
      expect(initial.status, JSON.stringify(initial)).toBe(0);
      if (change === 'content') {
        await writeFile(
          f.path('b/content/index.d.ts'),
          'export declare const value:string;',
        );
      } else {
        // The canonical file and its bytes stay equal; only the ancestor's
        // physical binding changes after collection and the first admission.
        await rm(f.path('b/dist'));
        await symlink(f.path('b/second'), f.path('b/dist'), 'junction');
      }
      expect((await run()).status).toBe('admission-rejected');
      expect(starts).toBe(1);
    } finally {
      preflight.dispose();
      await f.cleanup();
    }
  },
);

it.each(['b', 'c'])(
  'matches a legal cross-Checker rule target independently (%s)',
  async (denied) => {
    const files: Record<string, string> = {
      'package.json':
        '{"name":"cross-checker-rule","private":true,"type":"module"}',
      'pnpm-workspace.yaml': 'packages:\n - .\n',
      'limina.config.mjs': 'export default {};',
    };
    for (const name of ['a', 'b', 'c']) {
      files[`${name}/tsconfig.json`] = JSON.stringify({
        compilerOptions: { module: 'NodeNext', types: [], noEmit: true },
        files: ['index.ts'],
        ...(name === 'a' && { liminaOptions: { graphRules: ['consumer'] } }),
      });
      files[`${name}/index.ts`] =
        name === 'a'
          ? 'import {b} from "../b/index.js"; export const a=b;'
          : `export const ${name}=1;`;
    }
    const f = await createSemanticRepairFixture(files);
    await mkdir(f.path('node_modules'), { recursive: true });
    const require = createRequire(import.meta.url);
    await symlink(
      path.dirname(require.resolve('vue-tsc/package.json')),
      f.path('node_modules/vue-tsc'),
      'junction',
    );
    const config = withFixtureGovernanceRoot({
      rootDir: f.root,
      configPath: f.path('limina.config.mjs'),
      scope: {
        checkers: {
          tsc: { include: ['a/tsconfig.json', 'b/tsconfig.json'] },
          'vue-tsc': { include: ['c/tsconfig.json'] },
        },
      },
      graph: {
        rules: {
          consumer: {
            deny: {
              refs: [
                { path: `${denied}/tsconfig.json`, reason: 'targeted policy' },
              ],
            },
          },
        },
      },
    });
    const preflight = new LiminaPreflightManager({ config });
    try {
      const graph = (await preflight.ensureGeneratedArtifactsMaterialized())
        .graph;
      const target = createCheckerTarget({
        checker: graph.checkers.find((checker) => checker.name === 'tsc')!,
        configPath: graph.sourceToBuild
          .get('tsc')!
          .get(f.path('a/tsconfig.json'))!.path,
        executionKind: 'build',
        projectRootDir: f.root,
        sourceConfigPath: f.path('a/tsconfig.json'),
      });
      const admission = new ExecutionAdmission(preflight, graph, [target]);
      const result = await admission.withAuthorizedTarget(
        target,
        'launch',
        async () => true,
      );
      expect(result.state).toBe(denied === 'b' ? 'refused' : 'executed');
      if (result.state === 'refused')
        expect(result.rejection.decision).toBe('denied');
    } finally {
      preflight.dispose();
      await f.cleanup();
    }
  },
);

async function fixture(
  isImplicit: boolean,
  isLabeled = true,
  isTransitive = false,
) {
  const options = { module: 'NodeNext', types: [], noEmit: true };
  const files = Object.fromEntries(
    ['a', 'b', 'c', 'd'].map((name) => [
      `tsconfig.${name}.json`,
      JSON.stringify({
        compilerOptions: options,
        files: [`${name}.ts`],
        ...(name === 'a' && {
          liminaOptions: {
            graphRules: isLabeled ? ['consumer'] : [],
            ...(isImplicit && {
              implicitRefs: [
                { path: './tsconfig.b.json', reason: 'dynamic use' },
              ],
            }),
          },
        }),
        ...(name === 'b' &&
          isTransitive && {
            liminaOptions: {
              graphRules: ['provider'],
              implicitRefs: [
                { path: './tsconfig.c.json', reason: 'transitive dynamic use' },
              ],
            },
          }),
      }),
    ]),
  );
  const f = await createSemanticRepairFixture({
    ...files,
    'package.json': JSON.stringify({
      name: 'admission-scope',
      type: 'module',
      private: true,
    }),
    'pnpm-workspace.yaml': 'packages:\n  - .\n',
    'limina.config.mjs': 'export default {};',
    'tsconfig.json': JSON.stringify({
      files: [],
      references: ['a', 'b', 'c', 'd'].map((name) => ({
        path: `./tsconfig.${name}.json`,
      })),
    }),
    'a.ts': isImplicit
      ? 'export const a = 1;'
      : 'import { b } from "./b.js"; export const a = b;',
    'b.ts': 'export const b = 1;',
    'c.ts': 'export const c = 1;',
    'd.ts': 'export const d = 1;',
  });
  const config = withFixtureGovernanceRoot({
    rootDir: f.root,
    configPath: f.path('limina.config.mjs'),
    scope: { checkers: { tsc: { include: ['tsconfig.json'] } } },
    graph: {
      rules: {
        provider: {
          deny: {
            refs: [{ path: 'tsconfig.c.json', reason: 'transitive denial' }],
          },
        },
        consumer: {
          deny: {
            refs: [{ path: 'tsconfig.b.json', reason: 'private provider' }],
          },
        },
      },
    },
  });
  const preflight = new LiminaPreflightManager({ config });
  const graph = (await preflight.ensureGeneratedArtifactsMaterialized()).graph;
  const checker = graph.checkers.find((item) => item.name === 'tsc')!;
  const targets = ['a', 'd'].map((name) =>
    createCheckerTarget({
      checker,
      configPath: graph.sourceToBuild
        .get('tsc')!
        .get(f.path(`tsconfig.${name}.json`))!.path,
      executionKind: 'build',
      projectRootDir: f.root,
      sourceConfigPath: f.path(`tsconfig.${name}.json`),
    }),
  );
  const started: string[] = [];
  return { f, config, preflight, graph, targets, started };
}

async function execute(input: Awaited<ReturnType<typeof fixture>>) {
  const workspaceContext = await input.preflight.ensureWorkspaceValidated();
  return executeCheckerBuildTargets({
    allCheckers: input.graph.checkers,
    config: input.config,
    flowDepth: 0,
    generatedGraph: input.graph,
    label: 'admission test',
    preflight: input.preflight,
    projectRootDir: input.f.root,
    targets: input.targets,
    watch: undefined,
    workspaceContext,
    runnerOptions: {
      config: input.config,
      report: { defer: true },
      runner: (target) => {
        input.started.push(target.sourceConfigPath!);
        return { configPath: target.configPath, status: 0 };
      },
    },
  });
}

describe('managed execution admission', () => {
  it('governs transitive implicit references absent from dependency edges', async () => {
    const input = await fixture(true, false, true);
    try {
      expect(input.graph.dependencyEdges).toEqual([]);
      const result = await execute(input);
      expect(input.started).toEqual([input.f.path('tsconfig.d.json')]);
      expect(result.failedTargets[0]?.message).toContain('transitive denial');
      expect(result.failedTargets[0]?.admission?.decision).toBe('denied');
    } finally {
      input.preflight.dispose();
      await input.f.cleanup();
    }
  });
  it.each([false, true])(
    'rejects the applicable reference and continues an independent target (isImplicit=%s)',
    async (isImplicit) => {
      const input = await fixture(isImplicit);
      try {
        const original = JSON.stringify(input.graph.dependencyAnalysis);
        const result = await execute(input);
        expect(result.passed).toBe(false);
        expect(result.failureKind).toBe('execution-admission');
        expect(input.started).toEqual([input.f.path('tsconfig.d.json')]);
        expect(result.results).toHaveLength(1);
        expect(result.targetOutcomes).toContainEqual(
          expect.objectContaining({
            id: input.targets[0]!.id,
            status: 'admission-rejected',
            decision: 'denied',
            stage: 'mutation',
          }),
        );
        expect(result.failedTargets[0]).not.toHaveProperty('exitCode');
        const issues = createCheckerFailureIssues({
          failedTargets: result.failedTargets,
          failureKind: result.failureKind,
          fallbackReason: 'not executed',
          fix: 'Review the applicable reference rule.',
          projectRootDir: input.f.root,
          task: 'checker:build',
          title: 'Admission rejected',
        });
        expect(issues[0]).toMatchObject({
          code: 'LIMINA_CHECKER_BUILD_ADMISSION_REJECTED',
          task: 'checker:build',
        });
        expect(JSON.stringify(input.graph.dependencyAnalysis)).toBe(original);
      } finally {
        input.preflight.dispose();
        await input.f.cleanup();
      }
    },
  );
  it.each(['labels', 'implicitRefs', 'extends'])(
    'invalidates changed %s without rejecting an independent target',
    async (field) => {
      const input = await fixture(false, false);
      try {
        const file = input.f.path('tsconfig.a.json');
        const config = JSON.parse(await readFile(file, 'utf8'));
        if (field === 'labels') config.liminaOptions.graphRules = ['consumer'];
        else if (field === 'implicitRefs')
          config.liminaOptions.implicitRefs = [
            { path: './tsconfig.c.json', reason: 'new relation' },
          ];
        else config.extends = './tsconfig.c.json';
        await writeFile(file, JSON.stringify(config));
        const result = await execute(input);
        expect(input.started).toEqual([input.f.path('tsconfig.d.json')]);
        expect(result.targetOutcomes).toContainEqual(
          expect.objectContaining({
            id: input.targets[0]!.id,
            status: 'admission-rejected',
            decision: 'unavailable',
          }),
        );
        const issues = createCheckerFailureIssues({
          failedTargets: result.failedTargets,
          failureKind: result.failureKind,
          fallbackReason: 'not executed',
          fix: 'Reanalyze the changed inputs.',
          hideExecutionDetails: true,
          projectRootDir: input.f.root,
          task: 'checker:build',
          title: 'Admission rejected',
        });
        const inputDiagnostic = expect.stringContaining(
          'LIMINA_EXECUTION_INPUT_UNAVAILABLE',
        );
        expect(issues[0]!.evidence).toEqual(
          expect.arrayContaining([
            { label: 'execution decision', value: 'unavailable' },
            { label: 'execution stage', value: 'mutation' },
            { label: 'execution target', value: input.targets[0]!.id },
            {
              label: 'execution diagnostics',
              lines: expect.arrayContaining([inputDiagnostic]),
            },
          ]),
        );
      } finally {
        input.preflight.dispose();
        await input.f.cleanup();
      }
    },
  );

  it('rejects changed invocation rules instead of rebasing the configuration', async () => {
    const input = await fixture(false, false);
    try {
      input.config.graph!.rules!.consumer!.deny!.refs = [];
      const result = await execute(input);
      expect(input.started).toEqual([]);
      expect(result.failureKind).toBe('execution-admission');
      expect(result.failedTargets).toHaveLength(2);
    } finally {
      input.preflight.dispose();
      await input.f.cleanup();
    }
  });
  it('does not apply an unselected label and invalidates only necessary source evidence', async () => {
    const input = await fixture(false, false);
    try {
      await writeFile(input.f.path('a.ts'), 'export const a = "changed";');
      const result = await execute(input);
      expect(result.targetOutcomes).toContainEqual(
        expect.objectContaining({
          id: input.targets[0]!.id,
          status: 'admission-rejected',
          decision: 'unavailable',
        }),
      );
      expect(input.started).toEqual([input.f.path('tsconfig.d.json')]);
    } finally {
      input.preflight.dispose();
      await input.f.cleanup();
    }
  });
});

it('authenticates permit identity, scope and callback lifetime before consumption', async () => {
  const input = await fixture(true, false);
  const admission = new ExecutionAdmission(
    input.preflight,
    input.graph,
    input.targets,
  );
  const [target, other] = input.targets;
  const effects: string[] = [];
  let escaped: ExecutionPermit;
  try {
    const result = await admission.withAuthorizedTarget(
      target!,
      'launch',
      async (permit) => {
        escaped = permit;
        const serialized = JSON.stringify(permit);
        for (const forged of [{ ...permit }, JSON.parse(serialized)])
          await expect(
            admission.assertPermit(forged, target!, 'launch'),
          ).rejects.toThrow('invalid or expired');
        await expect(
          admission.assertPermit(permit, other!, 'launch'),
        ).rejects.toThrow('invalid or expired');
        await expect(
          admission.assertPermit(permit, target!, 'mutation'),
        ).rejects.toThrow('invalid or expired');
        const providers = input.preflight.providers;
        input.preflight.providers = {
          ...providers,
          releaseDependencyMemos: () => {},
          dispose: () => {},
        };
        await expect(
          admission.assertPermit(permit, target!, 'launch'),
        ).rejects.toThrow('invalid or expired');
        input.preflight.providers = providers;
        target!.args.push('--verbose');
        await expect(
          admission.assertPermit(permit, target!, 'launch'),
        ).rejects.toThrow('invalid or expired');
        target!.args.pop();
        const artifactPlan = input.graph.artifactPlan;
        input.graph.artifactPlan = {
          ...artifactPlan,
          desiredRevision: identifier<'MaterializationRevision'>(
            `${artifactPlan.desiredRevision}-changed`,
          ),
        };
        await expect(
          admission.assertPermit(permit, target!, 'launch'),
        ).rejects.toThrow('invalid or expired');
        input.graph.artifactPlan = artifactPlan;
        const namespace = input.preflight.artifactNamespace;
        input.preflight.artifactNamespace = { ...namespace };
        await expect(
          admission.assertPermit(permit, target!, 'launch'),
        ).rejects.toThrow('invalid or expired');
        input.preflight.artifactNamespace = namespace;
        input.targets.push({ ...other!, args: ['--changed-selection'] });
        await expect(
          admission.assertPermit(permit, target!, 'launch'),
        ).rejects.toThrow('selection changed');
        input.targets.pop();
        const declaration = input.graph.sourceToDts
          .get('tsc')!
          .get(input.f.path('tsconfig.a.json'))!;
        const generated = input.graph.generatedFiles.get(declaration)!;
        const changed = JSON.parse(generated);
        changed.references = [];
        await writeFile(declaration, JSON.stringify(changed));
        await expect(
          admission.assertPermit(permit, target!, 'launch'),
        ).rejects.toThrow('invalid or expired');
        await writeFile(declaration, generated);
        await admission.assertPermit(permit, target!, 'launch');
        effects.push('authorized launch');
      },
    );
    expect(result.state).toBe('executed');
    await expect(
      admission.assertPermit(escaped!, target!, 'launch'),
    ).rejects.toThrow('invalid or expired');
    expect(effects).toEqual(['authorized launch']);
  } finally {
    input.preflight.dispose();
    await input.f.cleanup();
  }
});

it.each(['mutation', 'launch'] as const)(
  'rejects same-mtime source drift at %s after shared read-only evidence',
  async (stage) => {
    const input = await fixture(true, false);
    const admission = new ExecutionAdmission(
      input.preflight,
      input.graph,
      input.targets,
    );
    const target = input.targets[0]!;
    const file = input.f.path('a.ts');
    const contents = await readFile(file, 'utf8');
    const before = await stat(file);
    let effects = 0;
    try {
      const allowed = await admission.withAuthorizedTarget(
        target,
        stage,
        async (permit) => {
          await admission.assertPermit(permit, target, stage);
          effects += 1;
        },
      );
      expect(allowed.state).toBe('executed');
      await admission.withReadOnlyValidation(async () => {
        await admission.withTargetEvidence(target, async () => {});
        await admission.withTargetEvidence(target, async () => {});
        const result = await admission.withAuthorizedTarget(
          target,
          stage,
          async (permit) => {
            await writeFile(file, `${contents}\n// changed`);
            await utimes(file, before.atime, before.mtime);
            await admission.assertPermit(permit, target, stage);
            effects += 1;
          },
        );
        expect(result.state).toBe('refused');
      });
      expect(effects).toBe(1);
    } finally {
      input.preflight.dispose();
      await input.f.cleanup();
    }
  },
);

it.each(['tsc', 'vue-tsc'])(
  'revokes %s declaration owner checking before launching a previously admitted target',
  async (checker) => {
    const f = await createSemanticRepairFixture({
      'package.json': '{"name":"declaration-admission","private":true}',
      'limina.config.mjs': 'export default {};',
      'tsconfig.json':
        '{"files":[],"references":[{"path":"./tsconfig.a.json"},{"path":"./tsconfig.b.json"}]}',
      'tsconfig.a.json':
        '{"compilerOptions":{"module":"ESNext","moduleResolution":"bundler","types":[]},"files":["a.ts"]}',
      'tsconfig.b.json': '{"compilerOptions":{"types":[]},"files":["b.d.ts"]}',
      'a.ts': 'import type { B } from "./b"; export type A = B;',
      'b.d.ts': 'export interface B { value: string }',
    });
    if (checker === 'vue-tsc') {
      await mkdir(f.path('node_modules'), { recursive: true });
      const require = createRequire(import.meta.url);
      for (const name of ['vue-tsc', 'typescript'])
        await symlink(
          path.dirname(require.resolve(`${name}/package.json`)),
          f.path(`node_modules/${name}`),
          'junction',
        );
    }
    const config = withFixtureGovernanceRoot({
      rootDir: f.root,
      configPath: f.path('limina.config.mjs'),
      cache: false,
      scope: { checkers: { [checker]: { include: ['tsconfig.json'] } } },
    });
    const preflight = new LiminaPreflightManager({ config });
    try {
      const graph = (await preflight.ensureGeneratedArtifactsMaterialized())
        .graph;
      const target = createCheckerTarget({
        checker: graph.checkers[0]!,
        configPath: graph.sourceToBuild
          .get(checker)!
          .get(f.path('tsconfig.a.json'))!.path,
        executionKind: 'build',
        projectRootDir: f.root,
        sourceConfigPath: f.path('tsconfig.a.json'),
      });
      const admission = new ExecutionAdmission(preflight, graph, [target]);
      let launches = 0;
      const run = () =>
        admission.withAuthorizedTarget(target, 'launch', async (permit) => {
          await admission.assertPermit(permit, target, 'launch');
          launches++;
        });
      expect((await run()).state).toBe('executed');
      const recordUnexpectedLaunch = async () => {
        launches++;
      };
      for (const buildArguments of [
        [...target.args, '--noCheck'],
        target.args.map((argument, index) =>
          index === 2 ? 'tsconfig.b.json' : argument,
        ),
      ]) {
        const changed = { ...target, args: buildArguments };
        const fresh = new ExecutionAdmission(preflight, graph, [changed]);
        const result = await fresh.withAuthorizedTarget(
          changed,
          'launch',
          recordUnexpectedLaunch,
        );
        expect(result.state).toBe('refused');
        if (result.state === 'refused')
          expect(
            result.rejection.diagnostics.map((item) => item.message).join('\n'),
          ).toContain('qualified checker build target');
      }
      await writeFile(
        f.path('tsconfig.b.json'),
        '{"compilerOptions":{"types":[],"skipLibCheck":true},"files":["b.d.ts"]}',
      );
      await expect(run()).rejects.toBeInstanceOf(AnalysisInputDriftError);
      expect(launches).toBe(1);
    } finally {
      preflight.dispose();
      await f.cleanup();
    }
  },
);

it('revokes Vue declaration receipts when the actual CLI entry changes', async () => {
  const f = await createSemanticRepairFixture({
    'package.json': '{"name":"vue-entry-admission","private":true}',
    'limina.config.mjs': 'export default {};',
    'tsconfig.json':
      '{"files":[],"references":[{"path":"./tsconfig.a.json"},{"path":"./tsconfig.b.json"}]}',
    'tsconfig.a.json':
      '{"compilerOptions":{"module":"ESNext","moduleResolution":"bundler","types":[]},"files":["a.ts"]}',
    'tsconfig.b.json': '{"compilerOptions":{"types":[]},"files":["b.d.ts"]}',
    'a.ts': 'import type { B } from "./b"; export type A = B;',
    'b.d.ts': 'export interface B { value: string }',
  });
  const require = createRequire(import.meta.url);
  const fromVue = createRequire(require.resolve('vue-tsc/package.json'));
  await cp(
    path.dirname(require.resolve('vue-tsc/package.json')),
    f.path('node_modules/vue-tsc'),
    { recursive: true },
  );
  for (const name of [
    'typescript',
    '@vue/language-core',
    '@volar/typescript',
  ]) {
    const target = f.path(`node_modules/${name}`);
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(
      path.dirname(fromVue.resolve(`${name}/package.json`)),
      target,
      'junction',
    );
  }
  const config = withFixtureGovernanceRoot({
    rootDir: f.root,
    configPath: f.path('limina.config.mjs'),
    cache: false,
    scope: { checkers: { 'vue-tsc': { include: ['tsconfig.json'] } } },
  });
  const preflight = new LiminaPreflightManager({ config });
  try {
    const graph = (await preflight.ensureGeneratedArtifactsMaterialized())
      .graph;
    const target = createCheckerTarget({
      checker: graph.checkers[0]!,
      configPath: graph.checkerEntries.get('vue-tsc')!,
      executionKind: 'build',
      projectRootDir: f.root,
    });
    const admission = new ExecutionAdmission(preflight, graph, [target]);
    let launches = 0;
    const run = () =>
      executeAuthorizedTypecheck({ admission }, target, () => {
        launches++;
        return { configPath: target.configPath, status: 0 };
      });
    expect((await run()).status).toBe(0);
    const entry = f.path('node_modules/vue-tsc/bin/vue-tsc.js');
    await writeFile(
      entry,
      `${await readFile(entry, 'utf8')}\n// Changed execution entry.\n`,
    );
    expect((await run()).status).toBe('admission-rejected');
    // Creating a new admission object cannot adopt a changed entry using the
    // earlier candidate receipt: its original compiler-read fence still binds.
    const renewed = new ExecutionAdmission(preflight, graph, [target]);
    expect(
      (
        await executeAuthorizedTypecheck({ admission: renewed }, target, () => {
          launches++;
          return { configPath: target.configPath, status: 0 };
        })
      ).status,
    ).toBe('admission-rejected');
    expect(launches).toBe(1);
  } finally {
    preflight.dispose();
    await f.cleanup();
  }
});
