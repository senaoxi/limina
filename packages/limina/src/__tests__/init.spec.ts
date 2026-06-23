import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalize as normalizePath } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../commands/init';
import { LiminaFlowReporter } from '../flow';
import { InitLogger } from '../logger';
import { toPortablePath, toPortablePaths } from './helpers/path';

const confirmMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('@clack/prompts', () => ({
  confirm: confirmMock,
  isCancel: (value: unknown) => value === 'cancel',
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

async function createFixture(files: Record<string, string>): Promise<{
  cleanup: () => Promise<void>;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-init-')),
  );

  for (const [relativePath, text] of Object.entries(files)) {
    await writeText(path.join(rootDir, relativePath), text);
  }

  return {
    cleanup: async () => {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    },
    rootDir,
  };
}

function stringifyConfig(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function mockExecFileWithNpxResult(error: Error | null = null): void {
  execFileMock.mockImplementation(
    (
      command: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      if (command === 'npx') {
        callback(error, '');
        return {};
      }

      const isPnpmListCommand =
        args.slice(-5).join('\0') === 'recursive\0list\0--depth\0-1\0--json';

      if (isPnpmListCommand) {
        callback(null, '[]');
        return {};
      }

      callback(new Error('unexpected command'), '');
      return {};
    },
  );
}

function findNpxCall():
  | [
      command: string,
      args: string[],
      options: { cwd?: string },
      callback: unknown,
    ]
  | undefined {
  return execFileMock.mock.calls.find(([command]) => command === 'npx') as
    | [
        command: string,
        args: string[],
        options: { cwd?: string },
        callback: unknown,
      ]
    | undefined;
}

function setTty(value: boolean): () => void {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(
    process.stdin,
    'isTTY',
  );
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(
    process.stdout,
    'isTTY',
  );

  Object.defineProperty(process.stdin, 'isTTY', {
    configurable: true,
    value,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    value,
  });

  return () => {
    if (stdinDescriptor) {
      Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
    } else {
      delete (process.stdin as Partial<typeof process.stdin>).isTTY;
    }
    if (stdoutDescriptor) {
      Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
    } else {
      delete (process.stdout as Partial<typeof process.stdout>).isTTY;
    }
  };
}

function createBufferedFlow(): {
  chunks: string[];
  flow: LiminaFlowReporter;
} {
  const chunks: string[] = [];

  return {
    chunks,
    flow: new LiminaFlowReporter({
      env: {
        CI: 'true',
      },
      output: {
        write: (message) => {
          chunks.push(message);
        },
      },
      stdout: {
        isTTY: false,
      },
    }),
  };
}

const compilerOptions = {
  module: 'ESNext',
  moduleResolution: 'bundler',
  target: 'ES2023',
  types: [],
};

function typecheckConfig(include: string[]): string {
  return stringifyConfig({
    compilerOptions,
    include,
  });
}

function createWorkspaceFixture(): Record<string, string> {
  return {
    'package.json': stringifyConfig({
      name: 'root',
      private: true,
      type: 'module',
    }),
    'packages/bar/bar.ts': 'export const sayHello = () => "hello";\n',
    'packages/bar/package.json': stringifyConfig({
      exports: {
        '.': './bar.ts',
        './package.json': './package.json',
        './tools': './scripts/index.ts',
      },
      name: 'bar',
      type: 'module',
    }),
    'packages/bar/scripts/index.ts':
      'export const doSomething = () => "tools";\n',
    'packages/bar/scripts/tsconfig.tools.json': typecheckConfig(['index.ts']),
    'packages/bar/tsconfig.json': typecheckConfig(['bar.ts']),
    'packages/empty/package.json': stringifyConfig({
      name: 'empty',
      type: 'module',
    }),
    'packages/foo/foo.ts':
      "import { sayHello } from 'bar';\nimport { helper } from './helper';\nimport { internal } from '#internal';\nimport { self } from './self';\nexport const value = `${sayHello()}-${helper}-${internal}-${self}`;\n",
    'packages/foo/helper.ts': 'export const helper = "helper";\n',
    'packages/foo/internal.ts': 'export const internal = "internal";\n',
    'packages/foo/package.json': stringifyConfig({
      dependencies: {
        bar: 'workspace:*',
      },
      imports: {
        '#internal': './internal.ts',
      },
      name: 'foo',
      type: 'module',
    }),
    'packages/foo/tsconfig.helpers.json': typecheckConfig([
      'helper.ts',
      'internal.ts',
    ]),
    'packages/foo/self.ts': 'export const self = "self";\n',
    'packages/foo/tsconfig.lib.json': typecheckConfig(['foo.ts', 'self.ts']),
    'packages/foo2/foo2.ts':
      "import { doSomething } from 'bar/tools';\nexport const value = doSomething();\n",
    'packages/foo2/package.json': stringifyConfig({
      dependencies: {
        bar: 'workspace:*',
      },
      name: 'foo2',
      type: 'module',
    }),
    'packages/foo2/tsconfig.lib.json': typecheckConfig(['foo2.ts']),
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
  };
}

describe('runInit', () => {
  beforeEach(() => {
    confirmMock.mockReset();
    execFileMock.mockReset();
    mockExecFileWithNpxResult();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fails when no pnpm workspace root can be found', async () => {
    const fixture = await createFixture({
      'package.json': '{}\n',
    });

    try {
      await expect(
        runInit({
          clearScreen: false,
          cwd: fixture.rootDir,
          yes: true,
        }),
      ).rejects.toThrow(/no pnpm-workspace\.yaml/u);
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows generated graph tsconfig names during init', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({
        name: 'root',
      }),
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
      'tsconfig.build.json': stringifyConfig({
        files: [],
        references: [],
      }),
    });

    try {
      await expect(
        runInit({
          clearScreen: false,
          cwd: fixture.rootDir,
          yes: true,
        }),
      ).resolves.toMatchObject({
        rootDir: normalizePath(fixture.rootDir),
      });
      expect(
        await fileExists(path.join(fixture.rootDir, 'tsconfig.build.json')),
      ).toBe(true);
      expect(
        await readFile(path.join(fixture.rootDir, 'limina.config.mjs'), 'utf8'),
      ).toContain("mode: 'auto'");
      expect(
        await readFile(path.join(fixture.rootDir, 'limina.config.mjs'), 'utf8'),
      ).toContain('exclude: []');
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not preflight workspace import coverage during init', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({
        name: 'root',
      }),
      'packages/app/app.ts':
        "import { value } from 'dep';\nexport { value };\n",
      'packages/app/package.json': stringifyConfig({
        dependencies: {
          dep: 'workspace:*',
        },
        name: 'app',
      }),
      'packages/app/tsconfig.json': typecheckConfig(['app.ts']),
      'packages/dep/package.json': stringifyConfig({
        exports: {
          '.': './dist/index.d.ts',
        },
        name: 'dep',
      }),
      'packages/dep/dist/index.d.ts': 'export declare const value: number;\n',
      'packages/dep/src/index.ts': 'export const value = 1;\n',
      'packages/dep/tsconfig.json': typecheckConfig(['src/index.ts']),
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    });

    try {
      const result = await runInit({
        clearScreen: false,
        cwd: fixture.rootDir,
        yes: true,
      });

      expect(toPortablePaths(result.writtenFiles)).toEqual(
        expect.arrayContaining([
          toPortablePath(path.join(fixture.rootDir, 'limina.config.mjs')),
          toPortablePath(path.join(fixture.rootDir, '.gitignore')),
          toPortablePath(path.join(fixture.rootDir, 'package.json')),
        ]),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows referenced tsconfig inputs during init', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({
        name: 'root',
      }),
      'pnpm-workspace.yaml': 'packages: []\n',
      'src/index.ts': 'export const value = 1;\n',
      'tsconfig.json': stringifyConfig({
        compilerOptions,
        include: ['src/**/*.ts'],
        references: [
          {
            path: './packages/app',
          },
        ],
      }),
    });

    try {
      await expect(
        runInit({
          clearScreen: false,
          cwd: fixture.rootDir,
          yes: true,
        }),
      ).resolves.toMatchObject({
        buildCommand: 'pnpm limina:build',
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows scoped aggregator tsconfig files during init', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({
        name: 'root',
      }),
      'pnpm-workspace.yaml': 'packages: []\n',
      'tsconfig.lib.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './tsconfig.json',
          },
        ],
      }),
    });

    try {
      await expect(
        runInit({
          clearScreen: false,
          cwd: fixture.rootDir,
          yes: true,
        }),
      ).resolves.toMatchObject({
        buildCommand: 'pnpm limina:build',
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('creates a root package.json when the workspace root has none', async () => {
    const fixture = await createFixture({
      'pnpm-workspace.yaml': 'packages: []\n',
      'src/index.ts': 'export const value = 1;\n',
      'tsconfig.json': typecheckConfig(['src/**/*.ts']),
    });

    try {
      await runInit({
        clearScreen: false,
        cwd: fixture.rootDir,
        yes: true,
      });

      const rootManifest = await readJson<{
        devDependencies?: Record<string, string>;
        private?: boolean;
        scripts?: Record<string, string>;
        type?: string;
      }>(path.join(fixture.rootDir, 'package.json'));

      expect(rootManifest).toMatchObject({
        private: true,
        scripts: {
          'limina:build': 'limina checker build',
        },
        type: 'module',
      });
      expect(rootManifest.devDependencies?.limina).toMatch(/^\^/u);
      expect(rootManifest.devDependencies?.typescript).toBe('^5.9.0');
    } finally {
      await fixture.cleanup();
    }
  });

  it('adds missing minimum dependencies without changing existing ranges', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({
        dependencies: {
          limina: 'workspace:*',
        },
        name: 'root',
        private: true,
        scripts: {
          'limina:build': 'limina checker build',
        },
        type: 'module',
      }),
      'pnpm-workspace.yaml': 'packages: []\n',
    });

    try {
      const result = await runInit({
        clearScreen: false,
        cwd: fixture.rootDir,
        yes: true,
      });
      const rootManifest = await readJson<{
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      }>(path.join(fixture.rootDir, 'package.json'));

      expect(result.installRequired).toBe(true);
      expect(rootManifest.dependencies?.limina).toBe('workspace:*');
      expect(rootManifest.devDependencies?.limina).toBeUndefined();
      expect(rootManifest.devDependencies?.typescript).toBe('^5.9.0');
    } finally {
      await fixture.cleanup();
    }
  });

  it('migrates the legacy default check script to the build script', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({
        devDependencies: {
          limina: '^1.0.0',
          typescript: '^5.9.0',
        },
        name: 'root',
        private: true,
        scripts: {
          'limina:check': 'limina check',
        },
        type: 'module',
      }),
      'pnpm-workspace.yaml': 'packages: []\n',
    });

    try {
      const result = await runInit({
        clearScreen: false,
        cwd: fixture.rootDir,
        yes: true,
      });
      const rootManifest = await readJson<{
        scripts?: Record<string, string>;
      }>(path.join(fixture.rootDir, 'package.json'));

      expect(result.installRequired).toBe(false);
      expect(rootManifest.scripts).toMatchObject({
        'limina:build': 'limina checker build',
      });
      expect(rootManifest.scripts?.['limina:check']).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not rewrite package.json when scripts and dependencies already match', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({
        dependencies: {
          limina: 'workspace:*',
        },
        name: 'root',
        peerDependencies: {
          typescript: '^5.8.0',
        },
        private: true,
        scripts: {
          'limina:build': 'limina checker build',
        },
        type: 'module',
      }),
      'pnpm-workspace.yaml': 'packages: []\n',
    });

    try {
      const result = await runInit({
        clearScreen: false,
        cwd: fixture.rootDir,
        yes: true,
      });
      const rootManifest = await readJson<{
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      }>(path.join(fixture.rootDir, 'package.json'));

      expect(result.installRequired).toBe(false);
      expect(toPortablePaths(result.writtenFiles)).not.toContain(
        toPortablePath(path.join(fixture.rootDir, 'package.json')),
      );
      expect(rootManifest.dependencies?.limina).toBe('workspace:*');
      expect(rootManifest.peerDependencies?.typescript).toBe('^5.8.0');
      expect(rootManifest.devDependencies).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });

  it('writes config and gitignore without a root build aggregator', async () => {
    const fixture = await createFixture({
      'package.json': stringifyConfig({
        name: 'root',
        private: true,
        type: 'module',
      }),
      'packages/app/index.ts': 'export const value = 1;\n',
      'packages/app/package.json': stringifyConfig({
        name: 'app',
        type: 'module',
      }),
      'packages/app/tsconfig.json': typecheckConfig(['index.ts']),
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
      'scripts/build.ts': 'export const build = () => undefined;\n',
      'src/index.ts': 'export const root = 1;\n',
      'tsconfig.json': typecheckConfig(['src/**/*.ts']),
      'tsconfig.tools.json': typecheckConfig(['scripts/**/*.ts']),
    });

    try {
      await runInit({
        clearScreen: false,
        cwd: fixture.rootDir,
        yes: true,
      });

      expect(
        await fileExists(path.join(fixture.rootDir, 'tsconfig.build.json')),
      ).toBe(false);
      expect(
        await fileExists(
          path.join(fixture.rootDir, 'packages/app/tsconfig.build.json'),
        ),
      ).toBe(false);
      expect(
        await readFile(path.join(fixture.rootDir, 'limina.config.mjs'), 'utf8'),
      ).toContain("mode: 'auto'");
      expect(
        await readFile(path.join(fixture.rootDir, 'limina.config.mjs'), 'utf8'),
      ).toContain('exclude: []');
      expect(
        await readFile(path.join(fixture.rootDir, 'limina.config.mjs'), 'utf8'),
      ).not.toContain('include:');
      expect(
        await readFile(path.join(fixture.rootDir, '.gitignore'), 'utf8'),
      ).toContain('.limina/');
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('writes config, gitignore, and root script without source-level graph configs', async () => {
    const fixture = await createFixture(createWorkspaceFixture());

    try {
      const result = await runInit({
        clearScreen: false,
        cwd: path.join(fixture.rootDir, 'packages/foo'),
        yes: true,
      });

      expect(result.installRequired).toBe(true);
      expect(
        await fileExists(
          path.join(fixture.rootDir, 'packages/foo/tsconfig.lib.dts.json'),
        ),
      ).toBe(false);
      expect(
        await fileExists(
          path.join(fixture.rootDir, 'packages/foo2/tsconfig.lib.dts.json'),
        ),
      ).toBe(false);
      expect(
        await fileExists(
          path.join(fixture.rootDir, 'packages/bar/tsconfig.build.json'),
        ),
      ).toBe(false);
      await expect(
        fileExists(
          path.join(fixture.rootDir, 'packages/empty/tsconfig.build.json'),
        ),
      ).resolves.toBe(false);
      expect(
        await readFile(path.join(fixture.rootDir, 'limina.config.mjs'), 'utf8'),
      ).toContain("mode: 'auto'");
      expect(
        await readFile(path.join(fixture.rootDir, 'limina.config.mjs'), 'utf8'),
      ).toContain('exclude: []');
      expect(
        await readFile(path.join(fixture.rootDir, 'limina.config.mjs'), 'utf8'),
      ).not.toContain('include:');
      expect(
        await readFile(path.join(fixture.rootDir, 'limina.config.mjs'), 'utf8'),
      ).not.toContain('entry:');
      expect(
        await readFile(path.join(fixture.rootDir, '.gitignore'), 'utf8'),
      ).toContain('.limina/');

      const rootManifest = await readJson<{
        devDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
      }>(path.join(fixture.rootDir, 'package.json'));

      expect(rootManifest.scripts?.['limina:build']).toBe(
        'limina checker build',
      );
      expect(rootManifest.devDependencies?.limina).toMatch(/^\^/u);
      expect(rootManifest.devDependencies?.typescript).toBe('^5.9.0');
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('is idempotent when generated files already match', async () => {
    const liminaConfig = `import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      mode: 'auto',
      exclude: [],
    },
  },
});
`;
    const fixture = await createFixture({
      '.gitignore': '.limina/\n',
      'limina.config.mjs': liminaConfig,
      'package.json': stringifyConfig({
        devDependencies: {
          limina: '^1.0.0',
          typescript: '^5.9.0',
        },
        name: 'root',
        private: true,
        scripts: {
          'limina:build': 'limina checker build',
        },
        type: 'module',
      }),
      'pnpm-workspace.yaml': 'packages: []\n',
    });

    try {
      const result = await runInit({
        clearScreen: false,
        cwd: fixture.rootDir,
        yes: true,
      });

      expect(result.writtenFiles).toEqual([]);
      expect(result.removedPaths).toEqual([]);
      expect(result.skillInstallStatus).toBe('skipped');
      expect(findNpxCall()).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });

  it('reports init flow steps with skipped reasons', async () => {
    const liminaConfig = `import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      mode: 'auto',
      exclude: [],
    },
  },
});
`;
    const fixture = await createFixture({
      '.gitignore': '.limina/\n',
      'limina.config.mjs': liminaConfig,
      'package.json': stringifyConfig({
        devDependencies: {
          limina: '^1.0.0',
          typescript: '^5.9.0',
        },
        name: 'root',
        private: true,
        scripts: {
          'limina:build': 'limina checker build',
        },
        type: 'module',
      }),
      'pnpm-workspace.yaml': 'packages: []\n',
    });
    const { chunks, flow } = createBufferedFlow();

    try {
      await runInit({
        clearScreen: false,
        cwd: fixture.rootDir,
        flow,
        yes: true,
      });

      const output = chunks.join('');

      expect(output).toContain('  [start] resolve workspace root\n');
      expect(output).toMatch(
        / {2}\[pass\] workspace root confirmed: .+ \(\d+ms\)\n/u,
      );
      expect(output).toMatch(
        / {2}\[skip\] root \.limina \(skipped: not present\) \(\d+ms\)\n/u,
      );
      expect(output).toMatch(
        / {2}\[skip\] limina\.config\.mjs \(skipped: already up to date\) \(\d+ms\)\n/u,
      );
      expect(output).toMatch(
        / {2}\[skip\] \.gitignore \(skipped: \.limina\/ already ignored\) \(\d+ms\)\n/u,
      );
      expect(output).toMatch(
        / {2}\[skip\] package\.json \(skipped: script and dependencies already present\) \(\d+ms\)\n/u,
      );
      expect(output).toMatch(
        / {2}\[skip\] limina skill \(skipped: --yes; run npx --yes skills add senaoxi\/docs-islands --skill limina\) \(\d+ms\)\n/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('removes only the root .limina directory without generating graph files', async () => {
    const fixture = await createFixture({
      '.limina/manifest.json': '{}\n',
      'package.json': stringifyConfig({
        name: 'root',
        private: true,
        type: 'module',
      }),
      'packages/pkg/.limina/manifest.json': '{}\n',
      'packages/pkg/package.json': stringifyConfig({
        name: 'pkg',
      }),
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    });

    try {
      const result = await runInit({
        clearScreen: false,
        cwd: fixture.rootDir,
        yes: true,
      });

      expect(toPortablePaths(result.removedPaths)).toEqual([
        toPortablePath(path.join(fixture.rootDir, '.limina')),
      ]);
      await expect(
        fileExists(path.join(fixture.rootDir, '.limina/manifest.json')),
      ).resolves.toBe(false);
      await expect(
        fileExists(path.join(fixture.rootDir, '.limina/tsconfig')),
      ).resolves.toBe(false);
      await expect(
        fileExists(
          path.join(fixture.rootDir, 'packages/pkg/.limina/manifest.json'),
        ),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('installs the Limina skill when the interactive prompt is accepted', async () => {
    const restoreTty = setTty(true);
    const fixture = await createFixture({
      'package.json': stringifyConfig({
        devDependencies: {
          limina: '^1.0.0',
          typescript: '^5.9.0',
        },
        name: 'root',
        private: true,
        scripts: {
          'limina:build': 'limina checker build',
        },
        type: 'module',
      }),
      'pnpm-workspace.yaml': 'packages: []\n',
    });
    confirmMock.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    mockExecFileWithNpxResult();

    try {
      const result = await runInit({
        clearScreen: false,
        cwd: fixture.rootDir,
      });
      const npxCall = findNpxCall();

      expect(result.skillInstallStatus).toBe('installed');
      expect(npxCall?.[0]).toBe('npx');
      expect(npxCall?.[1]).toEqual([
        '--yes',
        'skills',
        'add',
        'senaoxi/docs-islands',
        '--skill',
        'limina',
      ]);
      expect(toPortablePath(npxCall?.[2].cwd ?? '')).toBe(
        toPortablePath(fixture.rootDir),
      );
    } finally {
      restoreTty();
      await fixture.cleanup();
    }
  });

  it('does not install the Limina skill when the prompt is rejected', async () => {
    const restoreTty = setTty(true);
    const fixture = await createFixture({
      'package.json': stringifyConfig({
        devDependencies: {
          limina: '^1.0.0',
          typescript: '^5.9.0',
        },
        name: 'root',
        private: true,
        scripts: {
          'limina:build': 'limina checker build',
        },
        type: 'module',
      }),
      'pnpm-workspace.yaml': 'packages: []\n',
    });
    confirmMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    try {
      const result = await runInit({
        clearScreen: false,
        cwd: fixture.rootDir,
      });

      expect(result.skillInstallStatus).toBe('skipped');
      expect(findNpxCall()).toBeUndefined();
    } finally {
      restoreTty();
      await fixture.cleanup();
    }
  });

  it('keeps init successful when Limina skill installation fails', async () => {
    const restoreTty = setTty(true);
    const fixture = await createFixture({
      'package.json': stringifyConfig({
        devDependencies: {
          limina: '^1.0.0',
          typescript: '^5.9.0',
        },
        name: 'root',
        private: true,
        scripts: {
          'limina:build': 'limina checker build',
        },
        type: 'module',
      }),
      'pnpm-workspace.yaml': 'packages: []\n',
    });
    const warn = vi.spyOn(InitLogger, 'warn').mockImplementation(() => {});
    confirmMock.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    mockExecFileWithNpxResult(new Error('network unavailable'));

    try {
      const result = await runInit({
        clearScreen: false,
        cwd: fixture.rootDir,
      });

      expect(result.skillInstallStatus).toBe('failed');
      expect(result.buildCommand).toBe('pnpm limina:build');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('limina skill install failed'),
      );
    } finally {
      restoreTty();
      await fixture.cleanup();
    }
  });
});
