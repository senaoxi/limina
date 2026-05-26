import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defineConfig, getActiveCheckers, loadConfig } from '../config';

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

describe('defineConfig', () => {
  it('returns the explicit user config unchanged', () => {
    const config = defineConfig({
      config: {
        checkers: {
          typescript: {
            preset: 'tsc',
            entry: 'tsconfig.custom.build.json',
          },
        },
        source: {
          include: ['src/**/*.ts'],
          exclude: ['dist'],
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
              profile: 'esm-only',
            },
            boundary: {
              ignoredExternalPackages: ['@example/allowed'],
            },
            checks: ['publint', 'attw', 'boundary'],
            name: '@example/core',
            outDir: 'packages/core/dist',
            publint: {
              strict: true,
            },
          },
        ],
      },
    });

    expect(config.config?.checkers?.typescript?.entry).toBe(
      'tsconfig.custom.build.json',
    );
    expect(config.config?.source?.include).toEqual(['src/**/*.ts']);
    expect(config.config?.source?.exclude).toEqual(['dist']);
    expect(config.pipelines?.package).toEqual(['package:check']);
    expect(config.package?.entries?.[0]?.checks).toEqual([
      'publint',
      'attw',
      'boundary',
    ]);
  });

  it('resolves built-in checker defaults', () => {
    const activeCheckers = getActiveCheckers({
      config: {
        checkers: {
          typescript: {
            preset: 'tsc',
            entry: 'tsconfig.build.json',
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
      entry: 'tsconfig.build.json',
    });
  });

  it('returns config factories unchanged', async () => {
    const config = defineConfig(async ({ mode }) => ({
      config: {
        checkers: {
          typescript: {
            preset: 'tsc' as const,
            entry: `tsconfig.${mode}.build.json`,
          },
        },
      },
    }));

    await expect(config({ command: 'graph', mode: 'ci' })).resolves.toEqual({
      config: {
        checkers: {
          typescript: {
            preset: 'tsc',
            entry: 'tsconfig.ci.build.json',
          },
        },
      },
    });
  });
});

describe('loadConfig', () => {
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

      expect(config.rootDir).toBe(rootDir);
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
import { defineConfig } from '${new URL('../config.ts', import.meta.url).href}';

export default defineConfig(async ({ mode }) => ({
  config: {
    checkers: {
      typescript: {
        preset: 'tsc',
        entry: \`tsconfig.\${mode}.build.json\`,
      },
    },
  },
}));
`,
      );

      const config = await loadConfig({
        command: 'paths',
        cwd: rootDir,
        mode: 'ci',
      });

      expect(config.configPath).toBe(path.join(rootDir, 'limina.config.mjs'));
      expect(config.rootDir).toBe(rootDir);
      expect(config.config?.checkers?.typescript?.entry).toBe(
        'tsconfig.ci.build.json',
      );
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('finds the nearest limina config from cwd parents by default', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-config-'));

    try {
      await writeText(
        path.join(rootDir, 'pnpm-workspace.yaml'),
        'packages: []\n',
      );
      await writeText(
        path.join(rootDir, 'limina.config.mjs'),
        `
export default {};
`,
      );
      await writeText(path.join(rootDir, 'packages/core/package.json'), '{}\n');

      const config = await loadConfig({
        cwd: path.join(rootDir, 'packages/core'),
      });

      expect(config.configPath).toBe(path.join(rootDir, 'limina.config.mjs'));
      expect(config.rootDir).toBe(rootDir);
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

      expect(config.configPath).toBe(
        path.join(rootDir, 'tools/limina.config.mjs'),
      );
      expect(config.rootDir).toBe(rootDir);
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

      expect(config.configPath).toBe(configPath);
      expect(config.rootDir).toBe(rootDir);
    } finally {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    }
  });

  it('rejects explicit config paths outside the governed workspace', async () => {
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
      ).rejects.toThrow(/must be inside the governed pnpm workspace/u);
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

  it('rejects non-object checker maps', async () => {
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
        /config\.checkers must be an object keyed by checker name/u,
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
        entry: 'tsconfig.build.json',
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
        /checker entry must be a non-empty string path/u,
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
        entry: 'tsconfig.build.json',
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
        entry: 'tsconfig.custom.json',
      },
    },
  },
};
`,
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        /configured checker entries require a built-in checker adapter/u,
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
        entry: 'tsconfig.custom.json',
      },
    },
  },
};
`,
      );

      await expect(loadConfig({ cwd: rootDir })).rejects.toThrow(
        /checker extensions are fixed by built-in presets and cannot be configured[\s\S]*configured checker entries require a built-in checker adapter/u,
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
        /checker entry must be a non-empty string path/u,
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
        /checker entry must be a non-empty string path/u,
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
        entry: 'tsconfig.build.json',
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
              entry: 'tsconfig.build.json',
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
        /Searched for limina\.config\.mjs from/u,
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
