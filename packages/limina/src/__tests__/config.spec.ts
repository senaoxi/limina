import {
  defineConfig,
  getActiveCheckers,
  isAutoCheckerConfigMode,
  loadConfig,
} from '#config/runner';
import { prepareGeneratedTsconfigGraph } from '#core/build-graph/runner';
import { collectGraphProjectRoutes } from '#core/tsconfig/actions';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { toPortablePath, toPortableRelativePaths } from './helpers/path';

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

async function writeWorkspaceMetadata(rootDir: string): Promise<void> {
  await writeText(
    path.join(rootDir, 'pnpm-workspace.yaml'),
    'packages:\n  - packages/*\n',
  );
  await writeText(
    path.join(rootDir, 'package.json'),
    JSON.stringify({
      name: 'root',
      private: true,
    }),
  );
  await writeText(
    path.join(rootDir, 'packages/app/package.json'),
    JSON.stringify({
      name: 'app',
      private: true,
    }),
  );
}

function stringifyConfig(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

describe('defineConfig', () => {
  it('returns the explicit user config unchanged', () => {
    const config = defineConfig({
      config: {
        checkers: {
          typescript: {
            preset: 'tsc',
            include: ['tsconfig.custom.json'],
          },
        },
        source: {
          include: ['src/**/*.ts'],
          exclude: ['dist'],
        },
      },
      source: {
        importAuthority: {
          allow: {
            '@example/core': [
              {
                include: ['templates/**'],
                workspaceRootDependencies: ['react'],
                reason:
                  'Template files declare dependencies in generated apps.',
              },
            ],
          },
        },
        knip: {
          workspaces: {
            '@example/core': {
              entry: [
                {
                  files: ['packages/core/src/**/*.spec.ts'],
                  reason: 'Vitest loads test modules directly.',
                },
              ],
              ignoreDependencies: [
                {
                  dep: '@example/generated',
                  reason: 'Loaded by generated code.',
                },
              ],
              ignoreFiles: [
                {
                  file: 'packages/core/src/generated/runtime.ts',
                  reason: 'Loaded by a framework runtime.',
                },
              ],
            },
          },
        },
      },
      pipelines: {
        package: ['package:check'],
        typecheck: ['graph:check'],
      },
      package: {
        entries: [
          {
            attw: {
              ignoreRules: ['false-cjs'],
              level: 'warn',
              profile: 'esm-only',
            },
            boundary: {
              ignoredExternalPackages: ['@example/allowed'],
            },
            checks: ['publint', 'attw', 'boundary'],
            name: '@example/core',
            outDir: 'packages/core/dist',
            publint: {
              level: 'warning',
              strict: true,
            },
          },
        ],
      },
      graph: {
        conditionDomains: [
          {
            customConditions: ['browser', 'source'],
            entry: 'apps/web/tsconfig.dts.json',
            name: 'web',
          },
        ],
      },
      release: {
        contentHash: {
          baselineTag: 'next',
          builtinIgnore: false,
          ignore: ['client/**'],
        },
      },
      execution: {
        checkerBuild: 'auto',
        checkerTypecheck: 2,
        packageEntries: 'auto',
        releaseEntries: 2,
        tasks: 'auto',
      },
    });

    expect(
      config.config?.checkers &&
        !isAutoCheckerConfigMode(config.config.checkers)
        ? config.config.checkers.typescript?.include
        : undefined,
    ).toEqual(['tsconfig.custom.json']);
    expect(config.config?.source?.include).toEqual(['src/**/*.ts']);
    expect(config.config?.source?.exclude).toEqual(['dist']);
    expect(config.pipelines?.package).toEqual(['package:check']);
    expect(config.package?.entries?.[0]?.checks).toEqual([
      'publint',
      'attw',
      'boundary',
    ]);
    expect(
      config.source?.knip && typeof config.source.knip === 'object'
        ? config.source.knip.workspaces?.['@example/core']
        : undefined,
    ).toMatchObject({
      entry: [
        {
          files: ['packages/core/src/**/*.spec.ts'],
        },
      ],
      ignoreDependencies: [
        {
          dep: '@example/generated',
        },
      ],
      ignoreFiles: [
        {
          file: 'packages/core/src/generated/runtime.ts',
        },
      ],
    });
    expect(
      config.source?.importAuthority?.allow?.['@example/core']?.[0],
    ).toMatchObject({
      include: ['templates/**'],
      workspaceRootDependencies: ['react'],
    });
    expect(config.package?.entries?.[0]?.attw).toMatchObject({
      ignoreRules: ['false-cjs'],
      level: 'warn',
    });
    expect(config.package?.entries?.[0]?.publint).toMatchObject({
      level: 'warning',
      strict: true,
    });
    expect(config.graph?.conditionDomains?.[0]?.customConditions).toEqual([
      'browser',
      'source',
    ]);
    expect(config.release?.contentHash?.baselineTag).toBe('next');
    expect(config.release?.contentHash?.builtinIgnore).toBe(false);
    expect(config.release?.contentHash?.ignore).toEqual(['client/**']);
    expect(config.execution?.checkerTypecheck).toBe(2);
    expect(config.execution?.tasks).toBe('auto');
  });

  it('resolves built-in checker defaults', () => {
    const activeCheckers = getActiveCheckers({
      config: {
        checkers: {
          typescript: {
            preset: 'tsc',
            include: ['tsconfig.json'],
          },
        },
      },
    });

    expect(activeCheckers).toHaveLength(1);
    expect(activeCheckers[0]).toMatchObject({
      extensions: [
        '.d.cts',
        '.d.mts',
        '.d.ts',
        '.json',
        '.cts',
        '.mts',
        '.tsx',
        '.ts',
      ],
      name: 'typescript',
      preset: 'tsc',
      include: ['tsconfig.json'],
    });
  });

  it('accepts tsgo as a first-class TypeScript checker preset', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeWorkspaceMetadata(rootDir);
      await writeText(
        path.join(rootDir, 'tsconfig.build.json'),
        JSON.stringify({
          files: [],
          references: [
            {
              path: './packages/app/tsconfig.lib.dts.json',
            },
          ],
        }),
      );
      await writeText(
        path.join(rootDir, 'packages/app/tsconfig.lib.dts.json'),
        JSON.stringify({
          extends: './tsconfig.lib.json',
          references: [],
        }),
      );
      await writeText(
        path.join(rootDir, 'packages/app/tsconfig.lib.json'),
        JSON.stringify({
          files: ['src/index.ts'],
        }),
      );
      await writeText(
        path.join(rootDir, 'packages/app/tsconfig.json'),
        JSON.stringify({
          files: [],
          references: [
            {
              path: './tsconfig.lib.json',
            },
          ],
        }),
      );
      await writeText(
        path.join(rootDir, 'packages/app/src/index.ts'),
        'export const value = 1;\n',
      );

      const config = {
        config: {
          checkers: {
            nativeTypescript: {
              preset: 'tsgo' as const,
              include: ['packages/app/tsconfig.json'],
            },
          },
        },
        configPath: path.join(rootDir, 'limina.config.mjs'),
        rootDir,
      };
      const activeCheckers = getActiveCheckers(config);
      const generatedGraph = await prepareGeneratedTsconfigGraph(config, {
        workspacePackagesProvider: async () => [
          {
            directory: path.join(rootDir, 'packages/app'),
            manifest: {
              name: 'app',
              private: true,
            },
            name: 'app',
          },
        ],
      });
      const graphRoutes = collectGraphProjectRoutes(config, generatedGraph);

      expect(activeCheckers).toEqual([
        {
          exclude: [],
          extensions: [
            '.d.cts',
            '.d.mts',
            '.d.ts',
            '.json',
            '.cts',
            '.mts',
            '.tsx',
            '.ts',
          ],
          include: ['packages/app/tsconfig.json'],
          name: 'nativeTypescript',
          preset: 'tsgo',
        },
      ]);
      expect(graphRoutes.problems).toEqual([]);
      expect(graphRoutes.routes).toHaveLength(1);
      expect(graphRoutes.routes[0]?.checkerName).toBe('nativeTypescript');
      expect(
        toPortableRelativePaths(
          rootDir,
          graphRoutes.routes[0]?.projectPaths ?? [],
        ),
      ).toEqual([
        '.limina/tsconfig/checkers/nativeTypescript/solutions/packages/app/tsconfig.build.json',
        '.limina/tsconfig/checkers/nativeTypescript/projects/packages/app/tsconfig.lib.dts.json',
      ]);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('accepts vue-tsgo as a second-class Vue checker preset with graph coverage', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeWorkspaceMetadata(rootDir);
      await writeText(
        path.join(rootDir, 'tsconfig.vue.build.json'),
        JSON.stringify({
          files: [],
          references: [
            {
              path: './packages/app/tsconfig.vue.dts.json',
            },
          ],
        }),
      );
      await writeText(
        path.join(rootDir, 'packages/app/tsconfig.vue.dts.json'),
        JSON.stringify({
          extends: './tsconfig.vue.json',
          references: [],
        }),
      );
      await writeText(
        path.join(rootDir, 'packages/app/tsconfig.vue.json'),
        JSON.stringify({
          files: ['src/App.vue'],
        }),
      );
      await writeText(
        path.join(rootDir, 'packages/app/tsconfig.json'),
        JSON.stringify({
          files: [],
          references: [
            {
              path: './tsconfig.vue.json',
            },
          ],
        }),
      );
      await writeText(
        path.join(rootDir, 'packages/app/src/App.vue'),
        '<script setup lang="ts">const value = 1;</script>\n',
      );

      const config = {
        config: {
          checkers: {
            vue: {
              preset: 'vue-tsgo' as const,
              include: ['packages/app/tsconfig.json'],
            },
          },
        },
        configPath: path.join(rootDir, 'limina.config.mjs'),
        rootDir,
      };
      const activeCheckers = getActiveCheckers(config);
      const generatedGraph = await prepareGeneratedTsconfigGraph(config, {
        workspacePackagesProvider: async () => [
          {
            directory: path.join(rootDir, 'packages/app'),
            manifest: {
              name: 'app',
              private: true,
            },
            name: 'app',
          },
        ],
      });
      const graphRoutes = collectGraphProjectRoutes(config, generatedGraph);

      expect(activeCheckers).toEqual([
        {
          exclude: [],
          extensions: [
            '.d.cts',
            '.d.mts',
            '.d.ts',
            '.json',
            '.cts',
            '.mts',
            '.tsx',
            '.vue',
            '.ts',
          ],
          include: ['packages/app/tsconfig.json'],
          name: 'vue',
          preset: 'vue-tsgo',
        },
      ]);
      expect(graphRoutes.problems).toEqual([]);
      expect(graphRoutes.routes).toHaveLength(1);
      expect(graphRoutes.routes[0]?.checkerName).toBe('vue');
      expect(
        toPortableRelativePaths(
          rootDir,
          graphRoutes.routes[0]?.projectPaths ?? [],
        ),
      ).toEqual([
        '.limina/tsconfig/checkers/vue/solutions/packages/app/tsconfig.build.json',
        '.limina/tsconfig/checkers/vue/projects/packages/app/tsconfig.vue.dts.json',
      ]);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('resolves Vue checker extensions from the checker API', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'tsconfig.vue.build.json'),
        JSON.stringify({
          files: [],
          vueCompilerOptions: {
            extensions: ['.vue', '.md'],
          },
        }),
      );

      const config = {
        config: {
          checkers: {
            vue: {
              preset: 'vue-tsc' as const,
              include: ['tsconfig.vue.json'],
            },
          },
        },
        configPath: path.join(rootDir, 'limina.config.mjs'),
        rootDir,
      };
      const activeCheckers = getActiveCheckers(config);

      expect(activeCheckers[0]?.extensions).toEqual([
        '.d.cts',
        '.d.mts',
        '.d.ts',
        '.json',
        '.cts',
        '.mts',
        '.tsx',
        '.vue',
        '.ts',
      ]);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('returns config factories unchanged', async () => {
    const config = defineConfig(async ({ mode }) => ({
      config: {
        checkers: {
          typescript: {
            preset: 'tsc' as const,
            include: [`tsconfig.${mode}.json`],
          },
        },
      },
    }));

    await expect(config({ command: 'graph', mode: 'ci' })).resolves.toEqual({
      config: {
        checkers: {
          typescript: {
            preset: 'tsc',
            include: ['tsconfig.ci.json'],
          },
        },
      },
    });
  });
});

describe('loadConfig', () => {
  it('rejects unknown source boundary config fields under config.source', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  config: {
    source: {
      tsconfigOwnership: {
        ignore: [],
      },
    },
  },
};
`,
      );

      await expect(
        loadConfig({
          cwd: rootDir,
        }),
      ).rejects.toThrow('unknown source boundary config field');
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it.each([
    {
      error: /config\.source\.include must be a non-empty string array/u,
      name: 'empty include',
      source: {
        include: [],
      },
    },
    {
      error: /config\.source\.exclude must be a non-empty string array/u,
      name: 'empty exclude',
      source: {
        exclude: [],
      },
    },
    {
      error: /config\.source\.include entries must be non-empty strings/u,
      name: 'empty include entry',
      source: {
        include: [''],
      },
    },
    {
      error: /config\.source\.exclude entries must be non-empty strings/u,
      name: 'empty exclude entry',
      source: {
        exclude: [''],
      },
    },
    {
      error: /config\.source\.include may contain "\.\.\." at most once/u,
      name: 'duplicate include default token',
      source: {
        include: ['...', '...'],
      },
    },
    {
      error: /config\.source\.exclude may contain "\.\.\." at most once/u,
      name: 'duplicate exclude default token',
      source: {
        exclude: ['...', '...'],
      },
    },
  ])(
    'rejects invalid source boundary config: $name',
    async ({ error, source }) => {
      const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

      try {
        await writeText(
          path.join(rootDir, 'pnpm-workspace.yaml'),
          'packages: []\n',
        );
        await writeText(
          path.join(rootDir, 'limina.config.mjs'),
          `export default ${stringifyConfig({
            config: {
              source,
            },
          })}`,
        );

        await expect(
          loadConfig({
            cwd: rootDir,
          }),
        ).rejects.toThrow(error);
      } finally {
        await rm(rootDir, {
          force: true,
          recursive: true,
        });
      }
    },
  );

  it('accepts source default tokens and embedded default-like glob segments', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `export default ${stringifyConfig({
          config: {
            source: {
              exclude: ['...', 'generated/.../**'],
              include: ['...', 'src/.../*.ts'],
            },
          },
        })}`,
      );

      const config = await loadConfig({
        cwd: rootDir,
      });

      expect(config.config?.source?.include).toEqual(['...', 'src/.../*.ts']);
      expect(config.config?.source?.exclude).toEqual([
        '...',
        'generated/.../**',
      ]);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('rejects unknown top-level source config fields', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  source: {
    tsconfigOwnership: {
      ignore: [],
    },
  },
};
`,
      );

      await expect(
        loadConfig({
          cwd: rootDir,
        }),
      ).rejects.toThrow('unknown source config field');
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('validates source ambient declaration config and loads a complete rule', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      const invalidCases: [unknown, string][] = [
        [[], 'declarations must be an object'],
        [{ ambient: {} }, 'ambient must be an array'],
        [{ ambient: ['bad'] }, 'ambient declaration rules must be objects'],
        [
          { ambient: [{ reason: 'needed' }] },
          'ambient declaration include must be a non-empty string array',
        ],
        [
          { ambient: [{ include: [], reason: 'needed' }] },
          'ambient declaration include must be a non-empty string array',
        ],
        [
          { ambient: [{ include: [1], reason: 'needed' }] },
          'ambient declaration include entries must be non-empty strings',
        ],
        [
          { ambient: [{ include: ['types.d.ts'] }] },
          'ambient declaration reason must be a non-empty string',
        ],
        [
          { ambient: [{ include: ['types.d.ts'], reason: '   ' }] },
          'ambient declaration reason must be a non-empty string',
        ],
        [
          {
            ambient: [
              {
                allowSharedAcrossOwners: 'yes',
                include: ['types.d.ts'],
                reason: 'needed',
              },
            ],
          },
          'allowSharedAcrossOwners must be a boolean',
        ],
        [
          {
            ambient: [
              {
                allowTripleSlashReferences: 1,
                include: ['types.d.ts'],
                reason: 'needed',
              },
            ],
          },
          'allowTripleSlashReferences must be a boolean',
        ],
        [
          {
            ambient: [
              { include: ['types.d.ts'], reason: 'needed', unknown: true },
            ],
          },
          'unknown ambient declaration rule field',
        ],
      ];

      for (const [index, [declarations, message]] of invalidCases.entries()) {
        const configPath = `limina-${index}.config.mjs`;
        await writeText(
          path.join(rootDir, configPath),
          `export default ${JSON.stringify({ source: { declarations } })};\n`,
        );
        await expect(loadConfig({ configPath, cwd: rootDir })).rejects.toThrow(
          message,
        );
      }

      const configPath = 'limina-valid.config.mjs';
      await writeText(
        path.join(rootDir, configPath),
        `export default ${JSON.stringify({
          source: {
            declarations: {
              ambient: [
                {
                  allowSharedAcrossOwners: true,
                  allowTripleSlashReferences: true,
                  include: ['types/**/*.d.ts'],
                  reason: 'Shared type shims.',
                },
              ],
            },
          },
        })};\n`,
      );
      const config = await loadConfig({ configPath, cwd: rootDir });
      expect(config.source?.declarations?.ambient?.[0]).toEqual({
        allowSharedAcrossOwners: true,
        allowTripleSlashReferences: true,
        include: ['types/**/*.d.ts'],
        reason: 'Shared type shims.',
      });
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('loads owner-keyed source import authority config', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'package.json'),
        stringifyConfig({
          dependencies: {
            zod: '^1.0.0',
          },
          name: 'root',
          private: true,
        }),
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  source: {
    importAuthority: {
      allow: {
        "@example/app": [
          {
            include: ["test/**/*.ts"],
            workspaceRootDependencies: ["zod"],
            reason: "The root manifest declares shared test fixtures.",
          },
        ],
      },
    },
  },
};
`,
      );

      const config = await loadConfig({
        cwd: rootDir,
      });

      expect(
        config.source?.importAuthority?.allow?.['@example/app']?.[0],
      ).toMatchObject({
        include: ['test/**/*.ts'],
        workspaceRootDependencies: ['zod'],
      });
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('loads region extension and explicit region exclusions', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeWorkspaceMetadata(rootDir);
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  regions: {
    extendNestedPackageScopes: true,
    exclude: [
      {
        include: [
          'packages/app/test/fixtures/**',
          'packages/app/vendor/**',
        ],
        kind: 'pnpm-workspace',
        reason: 'Fixture workspaces are checked independently.',
      },
      {
        include: ['packages/legacy'],
        kind: 'workspace-package',
        reason: 'Legacy package.',
      },
      {
        include: ['packages/app/fixtures/parser'],
        kind: 'package-scope',
        reason: 'Parser fixture.',
      },
    ],
  },
};
`,
      );

      const config = await loadConfig({ cwd: rootDir });

      expect(config.regions?.extendNestedPackageScopes).toBe(true);
      expect(config.regions?.exclude?.[0]?.include).toEqual([
        'packages/app/test/fixtures/**',
        'packages/app/vendor/**',
      ]);
      expect(config.regions?.exclude?.[0]?.kind).toBe('pnpm-workspace');
      expect(config.regions?.exclude?.map((entry) => entry.kind)).toEqual([
        'pnpm-workspace',
        'workspace-package',
        'package-scope',
      ]);
      expect(config.regions?.exclude?.[0]?.reason).toBe(
        'Fixture workspaces are checked independently.',
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('treats nested package scope extension as disabled when omitted', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeWorkspaceMetadata(rootDir);
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  regions: {},
};
`,
      );

      const config = await loadConfig({ cwd: rootDir });

      expect(config.regions?.extendNestedPackageScopes ?? false).toBe(false);
      expect(config.regions?.exclude ?? []).toEqual([]);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('accepts an explicitly empty region exclusion list', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeWorkspaceMetadata(rootDir);
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  regions: {
    exclude: [],
  },
};
`,
      );

      const config = await loadConfig({ cwd: rootDir });

      expect(config.regions?.exclude).toEqual([]);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('rejects non-boolean nested package scope extension config', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeWorkspaceMetadata(rootDir);
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  regions: {
    extendNestedPackageScopes: 'yes',
  },
};
`,
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        'regions.extendNestedPackageScopes must be a boolean',
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('rejects unknown region config fields', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeWorkspaceMetadata(rootDir);
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  regions: {
    nestedPackages: true,
  },
};
`,
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        'unknown regions config field',
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it.each([
    {
      entry: `{ kind: 'workspace-package', include: [], reason: 'Checked separately.' }`,
      expected: 'regions.exclude.include must be a non-empty string array',
      name: 'empty include',
    },
    {
      entry: `{ kind: 'workspace-package', include: ['packages/app/vendor'], reason: '' }`,
      expected: 'reason must be a non-empty string',
      name: 'empty reason',
    },
    {
      entry: `{ kind: 'workspace-package', include: ['packages/app/vendor'], reason: 'Checked separately.', unexpected: true }`,
      expected: 'unknown regions.exclude entry field',
      name: 'unknown exclude field',
    },
    {
      entry: `{ include: ['packages/app/vendor'], reason: 'Checked separately.' }`,
      expected: 'regions.exclude[0].kind is required',
      name: 'missing kind',
    },
    {
      entry: `{ kind: 'unknown', include: ['packages/app/vendor'], reason: 'Checked separately.' }`,
      expected: 'regions.exclude[0].kind must be one of',
      name: 'unknown kind',
    },
    {
      entry: `{ kind: 1, include: ['packages/app/vendor'], reason: 'Checked separately.' }`,
      expected: 'regions.exclude[0].kind must be one of',
      name: 'non-string kind',
    },
  ])(
    'rejects invalid region exclusions: $name',
    async ({ entry, expected }) => {
      const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

      try {
        await writeWorkspaceMetadata(rootDir);
        await writeText(
          path.join(rootDir, 'limina.config.mjs'),
          `
export default {
  regions: {
    exclude: [${entry}],
  },
};
`,
        );

        await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(expected);
      } finally {
        await rm(rootDir, {
          force: true,
          recursive: true,
        });
      }
    },
  );

  it('rejects region boundary exclusions without a reason', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeWorkspaceMetadata(rootDir);
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  regions: {
    exclude: [
      {
        kind: 'pnpm-workspace',
        include: ['packages/app/test/fixtures/**'],
      },
    ],
  },
};
`,
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        'reason must be a non-empty string',
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it.each([
    {
      config:
        'allow: [{ files: ["packages/app/test/**/*.ts"], packages: ["zod"], reason: "legacy" }]',
      expected: 'allow must be an object keyed by source owner identity',
      name: 'allow array',
    },
    {
      config:
        'allow: { "": [{ workspaceRootDependencies: ["zod"], reason: "empty key" }] }',
      expected: 'allow keys must be non-empty source owner identities',
      name: 'empty owner key',
    },
    {
      config:
        'allow: { "@example/app": { workspaceRootDependencies: ["zod"], reason: "not an array" } }',
      expected: 'allow owner entries must be arrays of grants',
      name: 'non-array grant list',
    },
    {
      config: 'allow: { "@example/app": ["not an object"] }',
      expected:
        'importAuthority allow grants must be objects with workspaceRootDependencies and reason fields',
      name: 'non-object grant',
    },
    {
      config: 'allow: { "@example/app": [{ reason: "missing dependencies" }] }',
      expected: 'workspaceRootDependencies must be a non-empty string array',
      name: 'missing workspaceRootDependencies',
    },
    {
      config:
        'allow: { "@example/app": [{ workspaceRootDependencies: [], reason: "empty dependencies" }] }',
      expected: 'workspaceRootDependencies must be a non-empty string array',
      name: 'empty workspaceRootDependencies',
    },
    {
      config:
        'allow: { "@example/app": [{ workspaceRootDependencies: [""], reason: "empty dependency" }] }',
      expected: 'workspaceRootDependencies entries must be non-empty strings',
      name: 'empty workspaceRootDependencies entry',
    },
    {
      config:
        'allow: { "@example/app": [{ workspaceRootDependencies: ["zod"] }] }',
      expected: 'reason must be a non-empty string',
      name: 'missing reason',
    },
    {
      config:
        'allow: { "@example/app": [{ workspaceRootDependencies: ["zod"], reason: "" }] }',
      expected: 'reason must be a non-empty string',
      name: 'empty reason',
    },
    {
      config:
        'allow: { "@example/app": [{ include: [], workspaceRootDependencies: ["zod"], reason: "empty include" }] }',
      expected: 'include must be a non-empty string array',
      name: 'empty include',
    },
    {
      config:
        'allow: { "@example/app": [{ include: [""], workspaceRootDependencies: ["zod"], reason: "empty include entry" }] }',
      expected: 'include entries must be non-empty strings',
      name: 'empty include entry',
    },
    {
      config:
        'allow: { "@example/app": [{ files: ["packages/app/test/**/*.ts"], workspaceRootDependencies: ["zod"], reason: "legacy files" }] }',
      expected: 'files has been replaced by owner-root-relative include',
      name: 'legacy files',
    },
    {
      config:
        'allow: { "@example/app": [{ packages: ["zod"], reason: "legacy packages" }] }',
      expected: 'packages has been replaced by workspaceRootDependencies',
      name: 'legacy packages',
    },
    {
      config:
        'allow: { "@example/app": [{ specifiers: ["zod"], workspaceRootDependencies: ["zod"], reason: "legacy specifiers" }] }',
      expected:
        'direct specifier authority is not part of the workspace root dependency authority model',
      name: 'legacy specifiers',
    },
    {
      config:
        'allow: { "@example/app": [{ owner: "@example/app", workspaceRootDependencies: ["zod"], reason: "legacy owner" }] }',
      expected: 'owner is now expressed by the allow object key',
      name: 'legacy owner',
    },
  ])(
    'rejects invalid source import authority config: $name',
    async (testCase) => {
      const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

      try {
        await writeText(
          path.join(rootDir, 'pnpm-workspace.yaml'),
          'packages: []\n',
        );
        await writeText(
          path.join(rootDir, 'package.json'),
          stringifyConfig({
            name: 'root',
            private: true,
          }),
        );
        await writeText(
          path.join(rootDir, 'limina.config.mjs'),
          `
export default {
  source: {
    importAuthority: {
      ${testCase.config},
    },
  },
};
`,
        );

        await expect(
          loadConfig({
            cwd: rootDir,
          }),
        ).rejects.toThrow(testCase.expected);
      } finally {
        await rm(rootDir, {
          force: true,
          recursive: true,
        });
      }
    },
  );

  it('rejects workspace root dependency grants when the workspace root package.json is missing', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  source: {
    importAuthority: {
      allow: {
        "@example/app": [
          {
            include: ["src/**"],
            workspaceRootDependencies: ["zod"],
            reason: "The root manifest declares shared dependencies.",
          },
        ],
      },
    },
  },
};
`,
      );

      await expect(
        loadConfig({
          cwd: rootDir,
        }),
      ).rejects.toThrow(
        'workspaceRootDependencies grants require a workspace root package.json',
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('loads promised config objects', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default Promise.resolve({});
`,
      );

      const config = await loadConfig({
        cwd: rootDir,
      });

      expect(toPortablePath(config.rootDir)).toBe(toPortablePath(rootDir));
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('loads config factories with the current env', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
import { defineConfig } from '${new URL('../config/runner.ts', import.meta.url).href}';

export default defineConfig(async ({ mode }) => ({
  config: {
    checkers: {
      typescript: {
        preset: 'tsc',
        include: [\`tsconfig.\${mode}.json\`],
      },
    },
  },
}));
`,
      );

      const config = await loadConfig({
        command: 'graph',
        cwd: rootDir,
        mode: 'ci',
      });

      expect(toPortablePath(config.configPath)).toBe(
        toPortablePath(path.join(rootDir, 'limina.config.mjs')),
      );
      expect(toPortablePath(config.rootDir)).toBe(toPortablePath(rootDir));
      expect(
        config.config?.checkers &&
          !isAutoCheckerConfigMode(config.config.checkers)
          ? config.config.checkers.typescript?.include
          : undefined,
      ).toEqual(['tsconfig.ci.json']);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('finds the nearest limina.config.mts from cwd parents by default', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mts'),
        `
export default {};
`,
      );
      await writeText(path.join(rootDir, 'packages/core/package.json'), '{}\n');

      const config = await loadConfig({
        cwd: path.join(rootDir, 'packages/core'),
      });

      expect(toPortablePath(config.configPath)).toBe(
        toPortablePath(path.join(rootDir, 'limina.config.mts')),
      );
      expect(toPortablePath(config.rootDir)).toBe(toPortablePath(rootDir));
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('prefers limina.config.mts over limina.config.ts', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.ts'),
        `
export default {
  graph: {
    rules: {
      tsConfig: {},
    },
  },
};
`,
      );
      await writeText(
        path.join(rootDir, 'limina.config.mts'),
        `
export default {
  graph: {
    rules: {
      mtsConfig: {},
    },
  },
};
`,
      );

      const config = await loadConfig({
        cwd: rootDir,
      });

      expect(toPortablePath(config.configPath)).toBe(
        toPortablePath(path.join(rootDir, 'limina.config.mts')),
      );
      expect(Object.keys(config.graph?.rules ?? {})).toEqual(['mtsConfig']);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('prefers limina.config.mjs over limina.config.ts', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.ts'),
        `
export default {
  graph: {
    rules: {
      tsConfig: {},
    },
  },
};
`,
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  graph: {
    rules: {
      mjsConfig: {},
    },
  },
};
`,
      );

      const config = await loadConfig({
        cwd: rootDir,
      });

      expect(toPortablePath(config.configPath)).toBe(
        toPortablePath(path.join(rootDir, 'limina.config.mjs')),
      );
      expect(toPortablePath(config.rootDir)).toBe(toPortablePath(rootDir));
      expect(Object.keys(config.graph?.rules ?? {})).toEqual(['mjsConfig']);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('loads limina.config.ts when it is the only default config file', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.ts'),
        `
export default {};
`,
      );

      const config = await loadConfig({
        cwd: rootDir,
      });

      expect(toPortablePath(config.configPath)).toBe(
        toPortablePath(path.join(rootDir, 'limina.config.ts')),
      );
      expect(toPortablePath(config.rootDir)).toBe(toPortablePath(rootDir));
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('prefers the nearest directory before checking parent default configs', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.ts'),
        `
export default {
  graph: {
    rules: {
      root: {},
    },
  },
};
`,
      );
      await writeText(
        path.join(rootDir, 'packages/core/limina.config.mjs'),
        `
export default {
  graph: {
    rules: {
      child: {},
    },
  },
};
`,
      );
      await writeText(path.join(rootDir, 'packages/core/src/index.ts'), '\n');

      const config = await loadConfig({
        cwd: path.join(rootDir, 'packages/core/src'),
      });

      expect(toPortablePath(config.configPath)).toBe(
        toPortablePath(path.join(rootDir, 'packages/core/limina.config.mjs')),
      );
      expect(Object.keys(config.graph?.rules ?? {})).toEqual(['child']);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('infers the pnpm workspace root from a parent directory', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'tools/limina.config.mjs'),
        `
export default {};
`,
      );

      const config = await loadConfig({
        configPath: 'tools/limina.config.mjs',
        cwd: rootDir,
      });

      expect(toPortablePath(config.configPath)).toBe(
        toPortablePath(path.join(rootDir, 'tools/limina.config.mjs')),
      );
      expect(toPortablePath(config.rootDir)).toBe(toPortablePath(rootDir));
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('infers the pnpm workspace root from an explicit config path', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages:\n  - packages/*\n',
      );
      await writeText(
        path.join(rootDir, 'packages/child/pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'packages/child/limina.config.mjs'),
        `
export default {};
`,
      );

      const config = await loadConfig({
        configPath: 'packages/child/limina.config.mjs',
        cwd: rootDir,
      });

      expect(toPortablePath(config.rootDir)).toBe(
        toPortablePath(path.join(rootDir, 'packages/child')),
      );
      expect(toPortablePath(config.configPath)).toBe(
        toPortablePath(path.join(rootDir, 'packages/child/limina.config.mjs')),
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('accepts an absolute config path', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'tools/limina.config.mjs'),
        `
export default {};
`,
      );

      const configPath = path.join(rootDir, 'tools/limina.config.mjs');
      const config = await loadConfig({
        configPath,
        cwd: path.join(rootDir, 'packages/core'),
      });

      expect(toPortablePath(config.configPath)).toBe(
        toPortablePath(configPath),
      );
      expect(toPortablePath(config.rootDir)).toBe(toPortablePath(rootDir));
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('uses an explicit config path instead of nearby default configs', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.ts'),
        `
export default {
  graph: {
    rules: {
      defaultConfig: {},
    },
  },
};
`,
      );
      await writeText(
        path.join(rootDir, 'tools/custom.config.mjs'),
        `
export default {
  graph: {
    rules: {
      explicitConfig: {},
    },
  },
};
`,
      );

      const config = await loadConfig({
        configPath: 'tools/custom.config.mjs',
        cwd: rootDir,
      });

      expect(toPortablePath(config.configPath)).toBe(
        toPortablePath(path.join(rootDir, 'tools/custom.config.mjs')),
      );
      expect(Object.keys(config.graph?.rules ?? {})).toEqual([
        'explicitConfig',
      ]);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('loads a TypeScript config through the tsx config loader', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.ts'),
        `
enum Preset {
  Tsc = 'tsc',
}

export default {
  config: {
    checkers: {
      typescript: {
        preset: Preset.Tsc,
        include: ['tsconfig.json'],
      },
    },
  },
};
`,
      );

      const config = await loadConfig({
        configLoader: 'tsx',
        cwd: rootDir,
      });

      expect(
        config.config?.checkers &&
          !isAutoCheckerConfigMode(config.config.checkers)
          ? config.config.checkers.typescript?.include
          : undefined,
      ).toEqual(['tsconfig.json']);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('rejects unsupported config loaders', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.ts'),
        `
export default {};
`,
      );

      for (const configLoader of ['auto', 'unrun']) {
        await expect(
          loadConfig({
            configLoader: configLoader as never,
            cwd: rootDir,
          }),
        ).rejects.toThrow(/Expected one of: native, tsx/u);
      }
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('rejects explicit config paths without an owning pnpm workspace', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));
    const externalDir = await mkdtemp(
      path.join(tmpdir(), 'limina-external-config-'),
    );

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      const externalConfigPath = path.join(externalDir, 'limina.config.mjs');

      await writeText(
        externalConfigPath,
        `
throw new Error('external config should not be imported');
`,
      );

      await expect(
        loadConfig({
          configPath: externalConfigPath,
          cwd: rootDir,
        }),
      ).rejects.toThrow(/no pnpm-workspace\.yaml was found/u);
    } finally {
      await Promise.all([
        rm(rootDir, {
          force: true,
          recursive: true,
        }),
        rm(externalDir, {
          force: true,
          recursive: true,
        }),
      ]);
    }
  });

  it('rejects non-object config exports', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default null;
`,
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        /limina config must export or return an object/u,
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('loads release contentHash function config', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  release: {
    contentHash: {
      baselineTag: ({ importerName, dependencyName }) =>
        importerName === '@example/app' && dependencyName === '@example/dep'
          ? 'beta'
          : 'latest',
      builtinIgnore: true,
      ignore: ({ dependencyName }) =>
        dependencyName === '@example/dep' ? ['client/**'] : undefined,
    },
  },
};
`,
      );

      const config = await loadConfig({ cwd: rootDir });
      const baselineTag = config.release?.contentHash?.baselineTag;
      const builtinIgnore = config.release?.contentHash?.builtinIgnore;
      const ignore = config.release?.contentHash?.ignore;

      expect(typeof baselineTag).toBe('function');
      expect(builtinIgnore).toBe(true);
      expect(typeof ignore).toBe('function');

      if (typeof baselineTag === 'function') {
        expect(
          baselineTag({
            dependencyName: '@example/dep',
            importerName: '@example/app',
          }),
        ).toBe('beta');
      }

      if (typeof ignore === 'function') {
        expect(
          ignore({
            dependencyName: '@example/dep',
            importerName: '@example/app',
          }),
        ).toEqual(['client/**']);
        expect(
          ignore({
            dependencyName: '@example/other',
            importerName: '@example/app',
          }),
        ).toBeUndefined();
      }
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('rejects empty release contentHash baseline tags', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  release: {
    contentHash: {
      baselineTag: '',
    },
  },
};
`,
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        /baselineTag must be a non-empty string or function/u,
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('rejects non-boolean release contentHash builtinIgnore config', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  release: {
    contentHash: {
      builtinIgnore: 'yes',
    },
  },
};
`,
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        /builtinIgnore must be a boolean/u,
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('rejects non-array release contentHash ignore config', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  release: {
    contentHash: {
      ignore: 'client/**',
    },
  },
};
`,
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        /ignore must be an array of non-empty strings or function/u,
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('rejects empty release contentHash ignore patterns', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  release: {
    contentHash: {
      ignore: ['client/**', ''],
    },
  },
};
`,
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        /ignore patterns must be non-empty strings/u,
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('accepts canonical execution config', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  execution: {
    tasks: 'auto',
    checkerBuild: 'auto',
    checkerTypecheck: 2,
    packageEntries: 3,
    releaseEntries: 2,
  },
};
`,
      );

      const config = await loadConfig({ cwd: rootDir });

      expect(config.execution).toEqual({
        checkerBuild: 'auto',
        checkerTypecheck: 2,
        packageEntries: 3,
        releaseEntries: 2,
        tasks: 'auto',
      });
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('reports the 0.2.0 failFast migration error', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        'export default { execution: { failFast: false } };\n',
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        /execution\.failFast was removed in Limina 0\.2\.0/u,
      );
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('rejects invalid execution concurrency config', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  execution: {
    checkerTypecheck: 0,
  },
};
`,
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        /execution concurrency must be a positive integer or "auto"/u,
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('rejects unknown execution config fields', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  execution: {
    legacy: true,
  },
};
`,
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        /unknown execution config field/u,
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('accepts auto checker mode', () => {
    expect(
      defineConfig({
        config: {
          checkers: {
            exclude: ['packages/playground/tsconfig.json'],
            mode: 'auto',
          },
        },
      }),
    ).toEqual({
      config: {
        checkers: {
          exclude: ['packages/playground/tsconfig.json'],
          mode: 'auto',
        },
      },
    });
  });

  it('accepts Vue import analysis config', () => {
    expect(
      defineConfig({
        config: {
          imports: {
            vue: 'compiler-sfc',
          },
        },
      }),
    ).toEqual({
      config: {
        imports: {
          vue: 'compiler-sfc',
        },
      },
    });
  });

  it('rejects invalid Vue import analysis config', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  config: {
    imports: {
      vue: true,
    },
  },
};
`,
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        /config\.imports\.vue must be "heuristic" or "compiler-sfc"/u,
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('rejects string auto checker mode', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  config: {
    checkers: 'auto',
  },
};
`,
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        /checkers: "auto" has been removed/u,
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('rejects invalid auto checker exclude config', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  config: {
    checkers: {
      mode: 'auto',
      exclude: ['packages/playground/tsconfig.json', ''],
    },
  },
};
`,
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        /auto checker exclude entries must be non-empty string paths/u,
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('rejects invalid auto checker mode config', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  config: {
    checkers: {
      mode: 'manual',
    },
  },
};
`,
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        /auto checker config requires mode: "auto"/u,
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('rejects mixed auto checker and named checker config', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  config: {
    checkers: {
      mode: 'auto',
      typescript: {
        preset: 'tsc',
        include: ['tsconfig.json'],
      },
    },
  },
};
`,
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        /auto checker config must not be mixed with named checker entries/u,
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('rejects invalid checker maps', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  config: {
    checkers: ['typescript'],
  },
};
`,
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        /config\.checkers must be an object auto config or an object keyed by checker name/u,
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('rejects non-object checker entries', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  config: {
    checkers: {
      typescript: 'tsconfig.build.json',
    },
  },
};
`,
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        /checker entries must be objects/u,
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('rejects non-string checker presets', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  config: {
    checkers: {
      typescript: {
        preset: 1,
        include: ['tsconfig.json'],
      },
    },
  },
};
`,
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        /checker preset must be a non-empty string/u,
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('rejects non-string checker entries', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  config: {
    checkers: {
      typescript: {
        preset: 'tsc',
        entry: 1,
      },
    },
  },
};
`,
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        /checker\.entry has been removed; configure checker\.include/u,
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('rejects checker extension config', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  config: {
    checkers: {
      typescript: {
        preset: 'tsc',
        include: ['tsconfig.json'],
        extensions: ['ts'],
      },
    },
  },
};
`,
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        /checker extensions are fixed by built-in presets and cannot be configured/u,
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('rejects removed checker routes config', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  config: {
    checkers: {
      vue: {
        preset: 'vue-tsc',
        routes: {
          typecheck: 'tsconfig.sfc.json',
          build: 'tsconfig.vue.build.json',
        },
      },
    },
  },
};
`,
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        /checker routes are not supported/u,
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('rejects removed paths config', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  paths: {
    artifactDirectories: ['lib'],
  },
};
`,
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        /paths config has been removed/u,
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('rejects custom checker presets', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  config: {
    checkers: {
      custom: {
        preset: 'custom-checker',
        include: ['tsconfig.custom.json'],
      },
    },
  },
};
`,
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        /configured checkers require a built-in checker adapter/u,
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('rejects custom checker presets even when extensions are configured', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  config: {
    checkers: {
      custom: {
        preset: 'custom-checker',
        extensions: ['.custom'],
        include: ['tsconfig.custom.json'],
      },
    },
  },
};
`,
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        /checker extensions are fixed by built-in presets and cannot be configured[\s\S]*configured checkers require a built-in checker adapter/u,
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('rejects checker configs without entries', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  config: {
    checkers: {
      vue: {
        preset: 'vue-tsc',
      },
    },
  },
};
`,
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        /checker include must be a non-empty string array/u,
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('rejects empty checker entries', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  config: {
    checkers: {
      vue: {
        preset: 'vue-tsc',
        entry: '',
      },
    },
  },
};
`,
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        /checker\.entry has been removed; configure checker\.include/u,
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('accepts graph-capable checker entries without a separate typecheck dependency graph', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {
  config: {
    checkers: {
      typescript: {
        preset: 'tsc',
        include: ['tsconfig.json'],
      },
    },
  },
};
`,
      );

      await expect(loadConfig({ cwd: rootDir })).resolves.toMatchObject({
        config: {
          checkers: {
            typescript: {
              include: ['tsconfig.json'],
            },
          },
        },
      });
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('does not search for default config beyond the workspace root', async () => {
    const parentDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));
    const rootDir = path.join(parentDir, 'workspace');

    try {
      await writeText(
        path.join(parentDir, 'limina.config.mjs'),
        `
throw new Error('parent config should not be imported');
`,
      );
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );

      await expect(
        loadConfig({
          cwd: path.join(rootDir, 'packages/core'),
        }),
      ).rejects.toThrow(/up to the pnpm workspace root/u);
    } finally {
      await rm(parentDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('fails clearly when no limina config can be found upward', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        /Searched for "limina\.config\.mts", "limina\.config\.mjs", "limina\.config\.ts", "limina\.config\.js" from/u,
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('fails clearly when no pnpm workspace root can be inferred', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {};
`,
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        /no pnpm-workspace\.yaml was found/u,
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });
});
