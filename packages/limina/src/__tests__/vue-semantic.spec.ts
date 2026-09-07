import { parseCheckerProjectConfigForContext } from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import { createAnalysisProviders } from '#core';
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
import { describe, expect, it, vi } from 'vitest';
import {
  createUnsupportedVueToolchainCompatibilityError,
  resolveVueSemanticAdapter,
} from '../checker/vue-semantic-toolchain';
import { VueSemanticContextManager } from '../core/vue-semantic/context';
import { prepareVueSemanticDependencies } from '../core/vue-semantic/preparation';
import { runGraphExportImpl } from '../graph-check/runner';
import { LiminaPreflightManager } from '../preflight/manager';
import { createProfilingMetricsRecorder } from '../profiling/metrics';
import { createFixturePathResolver, toPortablePath } from './helpers/path';

const requireFromTest = createRequire(import.meta.url);

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

async function createFixture(
  files: Record<string, string>,
  options: { linkVueTsc?: boolean } = {},
): Promise<{
  cleanup: () => Promise<void>;
  path: (...segments: string[]) => string;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-vue-semantic-')),
  );
  for (const [relativePath, text] of Object.entries({
    'node_modules/vue/index.d.ts': 'export {}\n',
    'node_modules/vue/package.json':
      '{"name":"vue","version":"3.5.0","types":"index.d.ts"}\n',
    'package.json': '{"name":"fixture","private":true}\n',
    ...files,
  })) {
    await writeText(path.join(rootDir, relativePath), text);
  }
  if (options.linkVueTsc !== false) {
    const vueTscManifest = requireFromTest.resolve('vue-tsc/package.json');
    const vueTscTarget = path.dirname(vueTscManifest);
    const vueTscLink = path.join(rootDir, 'node_modules/vue-tsc');
    await mkdir(path.dirname(vueTscLink), { recursive: true });
    await symlink(vueTscTarget, vueTscLink, 'junction');
  }
  return {
    cleanup: () => rm(rootDir, { force: true, recursive: true }),
    path: createFixturePathResolver(rootDir),
    rootDir,
  };
}

function config(
  options: {
    target?: string;
    vueCompilerOptions?: Record<string, unknown>;
  } = {},
): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        allowArbitraryExtensions: true,
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        target: options.target ?? 'ES2022',
        types: [],
      },
      include: ['src/**/*'],
      vueCompilerOptions: options.vueCompilerOptions,
    },
    null,
    2,
  )}\n`;
}

function parseIdentity(options: {
  rootDir: string;
  virtualFiles?: ReadonlyMap<string, string>;
}) {
  const configPath = path.join(options.rootDir, 'tsconfig.json');
  const parsed = parseCheckerProjectConfigForContext({
    configPath,
    context: { checkerPresets: ['vue-tsc'], extensions: [] },
    projectRootDir: options.rootDir,
    virtualFiles: options.virtualFiles,
  });
  if (parsed.vueSemanticIdentity === undefined) {
    throw new Error('Fixture did not create a Vue semantic identity.');
  }
  return parsed.vueSemanticIdentity;
}

describe('Vue semantic architecture', () => {
  async function createExportFixture() {
    const fixture = await createFixture({
      'pnpm-workspace.yaml': 'packages: []\n',
      'package.json': '{"name":"fixture","private":true,"type":"module"}\n',
      'src/App.vue':
        '<script setup lang="ts">import value from "./value";</script><template>{{ value }}</template>\n',
      'src/value.ts': 'export default 1;\n',
      'tsconfig.json': config(),
    });
    const liminaConfig: ResolvedLiminaConfig = {
      config: { checkers: { 'vue-tsc': { include: ['tsconfig.json'] } } },
      configPath: fixture.path('limina.config.mjs'),
      rootDir: fixture.rootDir,
    };
    return { ...fixture, config: liminaConfig };
  }

  it.each([false, true])(
    'releases internally owned graph-export contexts after success or failure (%s)',
    async (failOutput) => {
      const fixture = await createExportFixture();
      const acquire = vi.spyOn(VueSemanticContextManager.prototype, 'acquire');
      const dispose = vi.spyOn(LiminaPreflightManager.prototype, 'dispose');
      const identities = new Set<string>();

      try {
        for (let iteration = 0; iteration < 3; iteration += 1) {
          acquire.mockClear();
          const exportGraph = runGraphExportImpl(fixture.config, {
            outputPath: failOutput
              ? fixture.path('src/App.vue/graph.json')
              : undefined,
          });
          await (failOutput
            ? expect(exportGraph).rejects.toThrow()
            : expect(exportGraph).resolves.toMatchObject({ schemaVersion: 1 }));

          expect(acquire).toHaveBeenCalled();
          for (const result of acquire.mock.results) {
            if (result.type !== 'return') throw result.value;
            identities.add(result.value.identity.id);
            // Any unreleased process-wide owner would keep this context active.
            expect(() => result.value.assertActive()).toThrow('disposed');
          }
          expect(dispose).toHaveBeenCalledTimes(iteration + 1);
        }
        expect(identities.size).toBe(1);
      } finally {
        acquire.mockRestore();
        dispose.mockRestore();
        await fixture.cleanup();
      }
    },
  );

  it.each(['preflight', 'providers'] as const)(
    'keeps borrowed %s usable across graph exports until caller disposal',
    async (borrowed) => {
      const fixture = await createExportFixture();
      const providers = createAnalysisProviders(fixture.config);
      const preflight = new LiminaPreflightManager({
        config: fixture.config,
        providers,
      });
      const dispose = vi.spyOn(providers, 'dispose');
      const acquire = vi.spyOn(VueSemanticContextManager.prototype, 'acquire');
      const options = borrowed === 'preflight' ? { preflight } : { providers };

      try {
        const first = await runGraphExportImpl(fixture.config, options);
        const context = acquire.mock.results.find(
          (result) => result.type === 'return',
        )?.value;
        expect(context).toBeDefined();
        const workspace = await preflight.ensureWorkspaceValidated();
        await expect(
          runGraphExportImpl(fixture.config, options),
        ).resolves.toEqual(first);
        expect(dispose).not.toHaveBeenCalled();
        expect(preflight.providers).toBe(providers);
        await expect(preflight.ensureWorkspaceValidated()).resolves.toBe(
          workspace,
        );
        for (const result of acquire.mock.results) {
          expect(result.value).toBe(context);
        }
        expect(() => context!.assertActive()).not.toThrow();
        preflight.dispose();
        expect(dispose).toHaveBeenCalledOnce();
        expect(() => context!.assertActive()).toThrow('disposed');
      } finally {
        preflight.dispose();
        dispose.mockRestore();
        acquire.mockRestore();
        await fixture.cleanup();
      }
    },
  );

  it('roots vue-tsc at the checker execution scope and resolves only its internal toolchain', async () => {
    const fixture = await createFixture({
      'packages/app/node_modules/vue-tsc/package.json':
        '{"name":"vue-tsc","version":"3.2.4"}\n',
      'packages/app/src/App.vue':
        '<script setup lang="ts">const value = 1</script>\n',
      'packages/app/tsconfig.json': config(),
    });
    const requireFromFixture = createRequire(fixture.path('package.json'));

    try {
      expect(() =>
        requireFromFixture.resolve('@vue/language-core/package.json'),
      ).toThrow();
      expect(() =>
        requireFromFixture.resolve('@volar/typescript/package.json'),
      ).toThrow();

      const parsed = parseCheckerProjectConfigForContext({
        configPath: fixture.path('packages', 'app', 'tsconfig.json'),
        context: { checkerPresets: ['vue-tsc'], extensions: [] },
        projectRootDir: fixture.rootDir,
      });

      expect(parsed.vueSemanticIdentity?.toolchain.adapter).toEqual({
        family: 'vue-tsc-3.2',
        kind: 'supported',
      });
      expect(parsed.vueSemanticIdentity?.toolchain.paths.vueTsc).not.toContain(
        toPortablePath(fixture.path('packages', 'app', 'node_modules')),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports missing and incomplete vue-tsc ownership without installing internals directly', async () => {
    const missing = await createFixture(
      {
        'src/App.vue': '<script setup lang="ts">export {}</script>\n',
        'tsconfig.json': config(),
      },
      { linkVueTsc: false },
    );
    const incomplete = await createFixture(
      {
        'node_modules/vue-tsc/package.json':
          '{"name":"vue-tsc","version":"3.2.4"}\n',
        'src/App.vue': '<script setup lang="ts">export {}</script>\n',
        'tsconfig.json': config(),
      },
      { linkVueTsc: false },
    );

    try {
      expect(() => parseIdentity({ rootDir: missing.rootDir })).toThrow(
        /Missing external checker:[\s\S]*checker: vue-tsc/u,
      );

      let thrown: unknown;
      try {
        parseIdentity({ rootDir: incomplete.rootDir });
      } catch (error) {
        thrown = error;
      }
      expect(String(thrown)).toContain('Unsupported vue-tsc toolchain:');
      expect(String(thrown)).toContain(
        'upgrade, downgrade, or reinstall vue-tsc',
      );
      expect(String(thrown)).not.toContain('pnpm add -D @vue/language-core');
      expect(String(thrown)).not.toContain('pnpm add -D @volar/typescript');
    } finally {
      await Promise.all([missing.cleanup(), incomplete.cleanup()]);
    }
  });

  it('reports an incompatible version tuple as one vue-tsc toolchain failure', () => {
    const tuple = {
      languageCore: '3.2.4',
      typeScript: '6.0.3',
      volarTypeScript: '2.4.26',
      vueTsc: '3.2.4',
    };

    expect(resolveVueSemanticAdapter(tuple).kind).toBe('unsupported');
    const error = createUnsupportedVueToolchainCompatibilityError({
      checkerExecutionRootDir: '/fixture',
      tuple,
    });
    expect(String(error)).toContain('Unsupported vue-tsc toolchain:');
    expect(String(error)).toContain('@volar/typescript 2.4.26');
    expect(String(error)).toContain('upgrade, downgrade, or reinstall vue-tsc');
    expect(String(error)).not.toContain('pnpm add -D @vue/language-core');
    expect(String(error)).not.toContain('pnpm add -D @volar/typescript');
  });

  it('uses one overlay-aware identity for profiles and Program options', async () => {
    const fixture = await createFixture({
      'src/App.component': '<script setup lang="ts">const value = 1</script>\n',
      'src/Page.md':
        '# Page\n\n<script setup lang="ts">const value = 1</script>\n',
      'src/Widget.html': '<div v-scope="{ value: 1 }"></div>\n',
      'tsconfig.json': config({ target: 'ES2022' }),
    });
    const configPath = fixture.path('tsconfig.json');
    const virtualConfig = config({
      target: 'ES5',
      vueCompilerOptions: {
        extensions: ['.vue', '.component'],
        petiteVueExtensions: ['.html'],
        vitePressExtensions: ['.md'],
      },
    });
    const manager = new VueSemanticContextManager();

    try {
      const identity = parseIdentity({
        rootDir: fixture.rootDir,
        virtualFiles: new Map([[configPath, virtualConfig]]),
      });
      const context = manager.acquire(identity);

      expect(identity.options.target).toBe(
        identity.toolchain.tsModule.ScriptTarget.ES5,
      );
      expect(context.program.getCompilerOptions().target).toBe(
        identity.toolchain.tsModule.ScriptTarget.ES5,
      );
      expect(
        [...identity.profilesByFileName.entries()].map(
          ([fileName, profile]) => [path.basename(fileName), profile],
        ),
      ).toEqual([
        ['App.component', 'vue-sfc'],
        ['Page.md', 'vitepress-markdown'],
        ['Widget.html', 'petite-vue-html'],
      ]);
      expect(context.languageServiceHost.getProjectVersion?.()).toBe(
        `${identity.generation}:${identity.id}`,
      );
    } finally {
      manager.dispose();
      await fixture.cleanup();
    }
  });

  it('reuses the finalized identity for generated overlays and keeps upstream profile precedence', async () => {
    const fixture = await createFixture({
      'src/App.custom': '<script setup lang="ts">export {}</script>\n',
      'tsconfig.json': config({
        vueCompilerOptions: {
          extensions: ['.vue', '.custom'],
          petiteVueExtensions: ['.custom'],
          vitePressExtensions: ['.custom'],
        },
      }),
    });
    const generatedConfigPath = fixture.path('tsconfig.generated.json');

    try {
      const identity = parseIdentity({ rootDir: fixture.rootDir });
      const generatedConfig = `${JSON.stringify({
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          target: 'ES5',
          types: [],
        },
        files: [fixture.path('src/App.custom')],
      })}\n`;
      const parsed = parseCheckerProjectConfigForContext({
        configPath: generatedConfigPath,
        context: {
          checkerPresets: ['vue-tsc'],
          extensions: [],
          vueSemanticIdentity: identity,
        },
        projectRootDir: fixture.rootDir,
        virtualFiles: new Map([[generatedConfigPath, generatedConfig]]),
      });

      expect(
        identity.profilesByFileName.get(fixture.path('src/App.custom')),
      ).toBe('vue-sfc');
      expect(parsed.vueSemanticIdentity).toBe(identity);
      expect(parsed.options.target).toBe(
        identity.toolchain.tsModule.ScriptTarget.ES5,
      );
      expect(identity.options.target).toBe(
        identity.toolchain.tsModule.ScriptTarget.ES2022,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('maps script src and generic imports without admitting synthetic helpers', async () => {
    const fixture = await createFixture({
      'src/App.vue': ['<script lang="ts" src="./entry.ts"></script>', ''].join(
        '\n',
      ),
      'src/Generic.vue': [
        '<script setup lang="ts" generic="T extends import(\'./types\').Thing">',
        'const value = 1',
        '</script>',
        '',
      ].join('\n'),
      'src/entry.ts': 'export default {}\n',
      'src/types.ts': 'export interface Thing { value: string }\n',
      'tsconfig.json': config(),
    });
    const metrics = createProfilingMetricsRecorder();
    const manager = new VueSemanticContextManager(metrics);

    try {
      const identity = parseIdentity({ rootDir: fixture.rootDir });
      const filePath = fixture.path('src/App.vue');
      const context = manager.acquire(identity);
      const prepared = [
        prepareVueSemanticDependencies({
          context,
          filePath,
        }),
        prepareVueSemanticDependencies({
          context,
          filePath: fixture.path('src/Generic.vue'),
        }),
      ];
      expect(prepared.every((result) => result.kind === 'supported')).toBe(
        true,
      );
      expect(
        prepared.flatMap((result) =>
          result.kind === 'supported'
            ? result.facts.map((fact) => [
                fact.importRecord.filePath,
                fact.importRecord.specifier,
                fact.semanticSpecifier,
                fact.target?.resolvedFileName,
              ])
            : [],
        ),
      ).toEqual([
        [filePath, './entry.js', './entry.js', fixture.path('src/entry.ts')],
        [
          fixture.path('src/Generic.vue'),
          './types',
          './types',
          fixture.path('src/types.ts'),
        ],
      ]);
      expect(
        metrics
          .snapshot()
          .filter((metric) => metric.name === 'vue-program-create')
          .reduce((total, metric) => total + metric.count, 0),
      ).toBe(0);
    } finally {
      manager.dispose();
      await fixture.cleanup();
    }
  });

  it('preserves official Vue source projection across ASCII tag boundaries, closing whitespace, CR, and UTF-16 text', async () => {
    const sourceText = [
      '<template>🧭</template>\r',
      '<script setup lang="ts">\r',
      "import first from './first';\r",
      '</script >\r',
      "<scripté>import ignored from './ignored'</scripté>\r",
      '<script lang="ts">\r',
      "import second from './second';\r",
      '</script\r>',
    ].join('');
    const fixture = await createFixture({
      'src/App.vue': sourceText,
      'src/first.ts': 'export default {}\n',
      'src/second.ts': 'export default {}\n',
      'tsconfig.json': config(),
    });
    const manager = new VueSemanticContextManager();

    try {
      const prepared = prepareVueSemanticDependencies({
        context: manager.acquire(parseIdentity({ rootDir: fixture.rootDir })),
        filePath: fixture.path('src/App.vue'),
      });

      expect(prepared.kind).toBe('supported');
      expect(
        prepared.kind === 'supported'
          ? prepared.facts.map((fact) => ({
              line: fact.importRecord.line,
              sourceText: sourceText.slice(
                fact.importRecord.locator.sourceStart,
                fact.importRecord.locator.sourceEnd,
              ),
              specifier: fact.semanticSpecifier,
            }))
          : [],
      ).toEqual([
        { line: 3, sourceText: "'./first'", specifier: './first' },
        { line: 7, sourceText: "'./second'", specifier: './second' },
      ]);
    } finally {
      manager.dispose();
      await fixture.cleanup();
    }
  });

  it('resolves Vue-to-Vue imports through the checker source projection', async () => {
    const fixture = await createFixture({
      'src/App.vue': [
        '<script setup lang="ts">',
        "import Component from './Component.vue';",
        'void Component;',
        '</script>',
        '',
      ].join('\n'),
      'src/Component.vue': '<script lang="ts">export default {}</script>\n',
      'tsconfig.json': config(),
    });
    const manager = new VueSemanticContextManager();

    try {
      const identity = parseIdentity({ rootDir: fixture.rootDir });
      expect(
        prepareVueSemanticDependencies({
          context: manager.acquire(identity),
          filePath: fixture.path('src/App.vue'),
        }),
      ).toMatchObject({
        facts: [
          {
            target: {
              resolvedBy: 'checker-source',
              resolvedFileName: fixture.path('src/Component.vue'),
            },
          },
        ],
        kind: 'supported',
      });
    } finally {
      manager.dispose();
      await fixture.cleanup();
    }
  });

  it('reuses one identity and disposes on project switches', async () => {
    const fixture = await createFixture({
      'src/App.vue': '<script setup lang="ts">import \'./dep\'</script>\n',
      'src/dep.ts': 'export {}\n',
      'tsconfig.json': config(),
    });
    const manager = new VueSemanticContextManager();

    try {
      const identity = parseIdentity({ rootDir: fixture.rootDir });
      const first = manager.acquire(identity);
      expect(manager.acquire(identity)).toBe(first);
      const second = manager.acquire({
        ...identity,
        generation: identity.generation + 1,
        id: `${identity.id}:next`,
      });
      expect(second).not.toBe(first);
      expect(() => first.assertActive()).toThrow('disposed');
      manager.release(second.identity);
      expect(() => second.assertActive()).toThrow('disposed');
    } finally {
      manager.dispose();
      await fixture.cleanup();
    }
  });

  it('keeps one process-wide heavy context across independent managers', async () => {
    const fixture = await createFixture({
      'src/App.vue': '<script setup lang="ts">export {}</script>\n',
      'tsconfig.json': config(),
    });
    const firstManager = new VueSemanticContextManager();
    const secondManager = new VueSemanticContextManager();

    try {
      const identity = parseIdentity({ rootDir: fixture.rootDir });
      const first = firstManager.acquire(identity);
      expect(secondManager.acquire(identity)).toBe(first);

      const switched = secondManager.acquire({
        ...identity,
        generation: identity.generation + 1,
        id: `${identity.id}:other-manager`,
      });
      expect(() => first.assertActive()).toThrow('disposed');

      firstManager.dispose();
      expect(() => switched.assertActive()).not.toThrow();
      secondManager.dispose();
      expect(() => switched.assertActive()).toThrow('disposed');
    } finally {
      firstManager.dispose();
      secondManager.dispose();
      await fixture.cleanup();
    }
  });
});
