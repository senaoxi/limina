import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSourceCheck } from '../commands/source';
import type { GraphConfig, ResolvedLiminaConfig } from '../config';

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

async function createFixture(
  files: Record<string, string>,
  graph?: GraphConfig,
): Promise<{
  cleanup: () => Promise<void>;
  config: ResolvedLiminaConfig;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-source-')),
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
    config: {
      config: {
        checkers: {
          typescript: {
            preset: 'tsc',
            entry: 'tsconfig.build.json',
          },
        },
      },
      configPath: path.join(rootDir, 'limina.config.mjs'),
      graph,
      rootDir,
    },
    rootDir,
  };
}

function stringifyConfig(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const buildCompilerOptions = {
  composite: true,
  declaration: true,
  emitDeclarationOnly: true,
  incremental: true,
  module: 'ESNext',
  moduleResolution: 'bundler',
  noEmit: false,
  outDir: './.tsbuild',
  strict: true,
  target: 'ES2023',
  types: [],
};

function typecheckConfig(include: string[]): string {
  return stringifyConfig({
    compilerOptions: {
      ...buildCompilerOptions,
      noEmit: true,
    },
    include,
  });
}

function buildConfig(options: {
  include: string[];
  limina?: unknown;
  tsBuildInfoFile?: string;
}): string {
  return stringifyConfig({
    ...(options.limina === undefined ? {} : { limina: options.limina }),
    compilerOptions: {
      ...buildCompilerOptions,
      rootDir: '.',
      tsBuildInfoFile: options.tsBuildInfoFile ?? './.tsbuild/lib.tsbuildinfo',
    },
    include: options.include,
  });
}

function createPackageFixture(options: {
  graph?: { limina?: string };
  manifest?: Record<string, unknown>;
  source: string;
}): Record<string, string> {
  return {
    'app/package.json': stringifyConfig({
      name: '@example/app',
      type: 'module',
      ...(options.manifest ?? {}),
    }),
    'app/src/index.ts': options.source,
    'app/tsconfig.lib.dts.json': buildConfig({
      include: ['src/**/*.ts'],
      limina: options.graph?.limina,
    }),
    'app/tsconfig.lib.json': typecheckConfig(['src/**/*.ts']),
    'tsconfig.build.json': stringifyConfig({
      files: [],
      references: [
        {
          path: './app/tsconfig.lib.dts.json',
        },
      ],
    }),
  };
}

describe('runSourceCheck package authority', () => {
  it('rejects external bare imports that are not declared by the nearest owner', async () => {
    const fixture = await createFixture(
      createPackageFixture({
        source: "import { z } from 'zod';\nexport const schema = z.string();\n",
      }),
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows external bare imports declared in dependencies or devDependencies', async () => {
    const fixture = await createFixture(
      createPackageFixture({
        manifest: {
          dependencies: {
            zod: '^1.0.0',
          },
          devDependencies: {
            vitest: '^1.0.0',
          },
        },
        source:
          "import { z } from 'zod';\nimport type { TestAPI } from 'vitest';\nexport const schema = z.string;\nexport type T = TestAPI;\n",
      }),
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows bundler virtual module imports', async () => {
    const fixture = await createFixture(
      createPackageFixture({
        source: "import 'virtual:group-icons.css';\nexport const ok = true;\n",
      }),
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects dependencies that are only declared in peer or optional sections', async () => {
    const fixture = await createFixture(
      createPackageFixture({
        manifest: {
          optionalDependencies: {
            lodash: '^1.0.0',
          },
          peerDependencies: {
            zod: '^1.0.0',
          },
        },
        source:
          "import { z } from 'zod';\nimport chunk from 'lodash/chunk';\nexport const value = [z, chunk];\n",
      }),
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('uses the nearest nested package owner for dependency authorization', async () => {
    const fixture = await createFixture({
      ...createPackageFixture({
        manifest: {
          dependencies: {
            zod: '^1.0.0',
          },
        },
        source: "export const rootValue = 'root';\n",
      }),
      'app/src/nested/package.json': stringifyConfig({
        name: '@example/nested',
        type: 'module',
      }),
      'app/src/nested/value.ts':
        "import { z } from 'zod';\nexport const nestedValue = z.string();\n",
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects declaration leaves whose file set mixes package owners', async () => {
    const fixture = await createFixture({
      ...createPackageFixture({
        source: "export const rootValue = 'root';\n",
      }),
      'app/src/nested/package.json': stringifyConfig({
        name: '@example/nested',
        type: 'module',
      }),
      'app/src/nested/value.ts': "export const nestedValue = 'nested';\n",
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects relative imports that escape the nearest package owner scope', async () => {
    const fixture = await createFixture({
      ...createPackageFixture({
        source: "export const rootValue = 'root';\n",
      }),
      'app/src/nested/package.json': stringifyConfig({
        name: '@example/nested',
        type: 'module',
      }),
      'app/src/nested/value.ts':
        "import { rootValue } from '../index';\nexport const nestedValue = rootValue;\n",
      'app/src/nested/tsconfig.lib.dts.json': buildConfig({
        include: ['*.ts'],
      }),
      'app/src/nested/tsconfig.lib.json': typecheckConfig(['*.ts']),
      'tsconfig.build.json': stringifyConfig({
        files: [],
        references: [
          {
            path: './app/src/nested/tsconfig.lib.dts.json',
          },
        ],
      }),
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('requires workspace packages to be declared by the nearest owner', async () => {
    const fixture = await createFixture({
      ...createPackageFixture({
        source:
          "import { internalValue } from '@example/internal';\nexport const value = internalValue;\n",
      }),
      'packages/internal/package.json': stringifyConfig({
        name: '@example/internal',
        type: 'module',
      }),
      'packages/internal/src/index.ts': 'export const internalValue = 1;\n',
      'packages/internal/tsconfig.lib.dts.json': buildConfig({
        include: ['src/**/*.ts'],
      }),
      'packages/internal/tsconfig.lib.json': typecheckConfig(['src/**/*.ts']),
      'pnpm-workspace.yaml': `
packages:
  - app
  - packages/*
`,
    });

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows self imports from the nearest owner package name', async () => {
    const fixture = await createFixture(
      createPackageFixture({
        source:
          "import type { Thing } from '@example/app';\nexport interface Thing { value: string }\n",
      }),
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('requires # package imports to be declared in owner package imports', async () => {
    const fixture = await createFixture(
      createPackageFixture({
        source:
          "import { internalValue } from '#internal/value';\nexport const value = internalValue;\n",
      }),
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('allows # package imports that match owner package imports', async () => {
    const fixture = await createFixture(
      createPackageFixture({
        manifest: {
          imports: {
            '#internal/*': './src/internal/*.ts',
          },
        },
        source:
          "import { internalValue } from '#internal/value';\nexport const value = internalValue;\n",
      }),
    );

    try {
      await writeText(
        path.join(fixture.rootDir, 'app/src/internal/value.ts'),
        'export const internalValue = 1;\n',
      );

      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('leaves label-based dependency deny rules to graph check', async () => {
    const fixture = await createFixture(
      createPackageFixture({
        graph: {
          limina: 'runtime-client',
        },
        source:
          "import { readFileSync } from 'node:fs';\nexport const value = readFileSync;\n",
      }),
      {
        rules: {
          'runtime-client': {
            deny: {
              deps: [
                {
                  name: 'node:*',
                  reason: 'client code must not import Node builtins',
                },
              ],
            },
          },
        },
      },
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not validate graph-only ref or dependency deny entries', async () => {
    const fixture = await createFixture(
      createPackageFixture({
        graph: {
          limina: 'runtime-client',
        },
        source: 'export const value = 1;\n',
      }),
      {
        rules: {
          'runtime-client': {
            deny: {
              refs: [
                {
                  path: 'app/tsconfig.missing.dts.json',
                  reason: 'graph check owns ref deny rules',
                },
              ],
              deps: [
                {
                  name: '@example/missing',
                  reason: 'graph check owns dependency deny rules',
                },
              ],
            },
          },
        },
      },
    );

    try {
      await expect(runSourceCheck(fixture.config)).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });
});
