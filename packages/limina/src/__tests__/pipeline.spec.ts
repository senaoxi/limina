import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ResolvedLiminaConfig } from '../config';
import { LiminaFlowReporter } from '../flow';
import {
  normalizePipelineStep,
  runDefaultCheck,
  runPipeline,
} from '../pipeline';

const green = (message: string): string => `\u001B[32m${message}\u001B[0m`;

async function createConfig(): Promise<{
  cleanup: () => Promise<void>;
  config: ResolvedLiminaConfig;
}> {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-pipeline-'));
  const configPath = path.join(rootDir, 'limina.config.mjs');

  await writeFile(configPath, 'export default {};\n');

  return {
    cleanup: async () => {
      await rm(rootDir, {
        force: true,
        recursive: true,
      });
    },
    config: {
      configPath,
      rootDir,
    },
  };
}

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

async function createOutputPackage(
  rootDir: string,
  packageName: string,
  source: string,
): Promise<string> {
  const packageDirName = packageName.split('/').at(-1) ?? packageName;
  const outDir = path.join(rootDir, 'packages', packageDirName, 'dist');

  await writeText(
    path.join(outDir, 'package.json'),
    JSON.stringify({
      dependencies: {
        '@example/dep': '1.0.0',
      },
      exports: {
        '.': './index.js',
      },
      name: packageName,
    }),
  );
  await writeText(path.join(outDir, 'index.js'), source);
  await writeText(path.join(outDir, 'README.md'), '# Example package\n');
  await writeText(path.join(outDir, 'LICENSE.md'), 'MIT\n');

  return outDir;
}

function createFlow(): {
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
      forceTty: false,
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

function createTtyFlow(): {
  chunks: string[];
  flow: LiminaFlowReporter;
} {
  const chunks: string[] = [];
  const stdout = {
    columns: 120,
    isTTY: true,
    write: (message: string | Uint8Array) => {
      chunks.push(
        message instanceof Uint8Array
          ? Buffer.from(message).toString()
          : message,
      );
      return true;
    },
  };

  return {
    chunks,
    flow: new LiminaFlowReporter({
      env: {},
      forceTty: true,
      stdout,
    }),
  };
}

describe('runPipeline', () => {
  it('recognizes source:check as a built-in task', () => {
    expect(normalizePipelineStep('source:check')).toEqual({
      name: 'source:check',
      type: 'task',
    });
  });

  it('recognizes checker:typecheck as a built-in task', () => {
    expect(normalizePipelineStep('checker:typecheck')).toEqual({
      name: 'checker:typecheck',
      type: 'task',
    });
  });

  it('recognizes release:check as a built-in task', () => {
    expect(normalizePipelineStep('release:check')).toEqual({
      name: 'release:check',
      type: 'task',
    });
  });

  it('recognizes nx:check as a built-in task', () => {
    expect(normalizePipelineStep('nx:check')).toEqual({
      name: 'nx:check',
      type: 'task',
    });
  });

  it('reports missing user pipeline config with a config hint', async () => {
    const fixture = await createConfig();

    try {
      await expect(runPipeline(fixture.config, 'missing')).rejects.toThrow(
        /Pipeline instruction "missing" was not found\.\nDefine it in limina\.config\.mjs under the "pipelines" field/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('runs the built-in default check pipeline without configured pipelines', async () => {
    const fixture = await createConfig();
    const { chunks, flow } = createFlow();

    fixture.config.config = {
      checkers: {
        typescript: {
          entry: 'tsconfig.build.json',
          preset: 'tsc',
        },
      },
    };

    try {
      await expect(runDefaultCheck(fixture.config, { flow })).resolves.toBe(
        false,
      );

      expect(
        chunks.some((chunk) => chunk.includes('[start] default check')),
      ).toBe(true);
      expect(
        chunks.some((chunk) => chunk.includes('[start] graph check')),
      ).toBe(true);
      expect(
        chunks.some((chunk) =>
          chunk.includes('[fail] default check blocked at graph:check'),
        ),
      ).toBe(true);
      expect(
        chunks.some((chunk) => chunk.includes('[skip] skipped: source:check')),
      ).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('passes all command steps in order', async () => {
    const fixture = await createConfig();
    const { chunks, flow } = createFlow();

    fixture.config.pipelines = {
      demo: [
        {
          args: ['-e', 'process.exit(0)'],
          command: process.execPath,
          type: 'command',
        },
        {
          args: ['-e', 'process.exit(0)'],
          command: process.execPath,
          type: 'command',
        },
      ],
    };

    try {
      await expect(runPipeline(fixture.config, 'demo', { flow })).resolves.toBe(
        true,
      );

      expect(
        chunks.some((chunk) => chunk.includes('[pass] pipeline: demo')),
      ).toBe(true);
      expect(
        chunks.filter((chunk) => chunk.includes('[pass] command:')).length,
      ).toBe(2);
    } finally {
      await fixture.cleanup();
    }
  });

  it('clears stale vue-tsgo cache before command steps', async () => {
    const fixture = await createConfig();

    await writeText(
      path.join(fixture.config.rootDir, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        type: 'module',
      }),
    );
    await writeText(
      path.join(fixture.config.rootDir, 'tsconfig.vue.build.json'),
      JSON.stringify({ files: [] }),
    );
    await writeText(
      path.join(fixture.config.rootDir, 'node_modules/.bin/vue-tsgo'),
      [
        '#!/usr/bin/env sh',
        'exec node "$(dirname "$0")/vue-tsgo.js" "$@"',
        '',
      ].join('\n'),
    );
    await writeText(
      path.join(fixture.config.rootDir, 'node_modules/.bin/vue-tsgo.js'),
      [
        "import { createHash } from 'node:crypto';",
        "import { existsSync, writeFileSync } from 'node:fs';",
        "import path from 'node:path';",
        'const configPath = path.resolve(process.cwd(), process.argv.at(-1));',
        "const hash = createHash('sha256').update(configPath).digest('hex').slice(0, 8);",
        "const stalePath = path.join(process.cwd(), 'node_modules/.cache/vue-tsgo', hash, 'stale.txt');",
        "writeFileSync(path.join(process.cwd(), 'stale-state.txt'), String(existsSync(stalePath)));",
        '',
      ].join('\n'),
    );
    await chmod(
      path.join(fixture.config.rootDir, 'node_modules/.bin/vue-tsgo'),
      0o755,
    );
    await writeText(
      path.join(
        fixture.config.rootDir,
        'node_modules/.cache/vue-tsgo',
        createHash('sha256')
          .update(path.join(fixture.config.rootDir, 'tsconfig.vue.build.json'))
          .digest('hex')
          .slice(0, 8),
        'stale.txt',
      ),
      'stale\n',
    );

    fixture.config.pipelines = {
      vue: [
        {
          args: ['--build', 'tsconfig.vue.build.json'],
          command: 'vue-tsgo',
          type: 'command',
        },
      ],
    };

    try {
      await expect(runPipeline(fixture.config, 'vue')).resolves.toBe(true);
      await expect(
        readFile(path.join(fixture.config.rootDir, 'stale-state.txt'), 'utf8'),
      ).resolves.toBe('false');
    } finally {
      await fixture.cleanup();
    }
  });

  it('passes package selection to package-aware built-in tasks', async () => {
    const fixture = await createConfig();

    try {
      const validOutDir = await createOutputPackage(
        fixture.config.rootDir,
        '@example/valid',
        "import '@example/dep';\n",
      );
      const invalidOutDir = await createOutputPackage(
        fixture.config.rootDir,
        '@example/invalid',
        "import 'node:fs';\n",
      );

      fixture.config.package = {
        entries: [
          {
            checks: ['boundary'],
            name: '@example/valid',
            outDir: validOutDir,
          },
          {
            checks: ['boundary'],
            name: '@example/invalid',
            outDir: invalidOutDir,
          },
        ],
      };
      fixture.config.pipelines = {
        publish: ['package:check'],
      };

      await expect(
        runPipeline(fixture.config, 'publish', {
          packageNames: ['@example/valid'],
        }),
      ).resolves.toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('collapses successful interactive command output', async () => {
    const fixture = await createConfig();
    const { chunks, flow } = createTtyFlow();

    fixture.config.pipelines = {
      demo: [
        {
          args: ['-e', 'console.log("command detail")'],
          command: process.execPath,
          type: 'command',
        },
      ],
    };

    try {
      await expect(runPipeline(fixture.config, 'demo', { flow })).resolves.toBe(
        true,
      );

      expect(chunks.some((chunk) => chunk.includes('◇      command: '))).toBe(
        true,
      );
      expect(chunks.some((chunk) => chunk.includes('command detail'))).toBe(
        true,
      );
      expect(
        chunks.some((chunk) => chunk.includes('\u001B[H\u001B[2J\u001B[3J')),
      ).toBe(true);
      expect(
        chunks.some((chunk) => chunk.includes(`${green('◆')}      command: `)),
      ).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('marks the blocking step and skips remaining steps on failure', async () => {
    const fixture = await createConfig();
    const { chunks, flow } = createFlow();

    fixture.config.pipelines = {
      demo: [
        {
          args: ['-e', 'process.exit(1)'],
          command: process.execPath,
          type: 'command',
        },
        {
          args: ['-e', 'process.exit(0)'],
          command: process.execPath,
          type: 'command',
        },
      ],
    };

    try {
      await expect(runPipeline(fixture.config, 'demo', { flow })).resolves.toBe(
        false,
      );

      expect(
        chunks.some((chunk) => chunk.includes('[fail] command failed:')),
      ).toBe(true);
      expect(
        chunks.some((chunk) => chunk.includes('[fail] pipeline blocked: demo')),
      ).toBe(true);
      expect(chunks.some((chunk) => chunk.includes('[skip] skipped:'))).toBe(
        true,
      );
    } finally {
      await fixture.cleanup();
    }
  });
});
