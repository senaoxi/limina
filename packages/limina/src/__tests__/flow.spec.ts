import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'pathe';
import { describe, expect, it, vi } from 'vitest';
import { createLiminaCheckFlowReporter, LiminaFlowReporter } from '../flow';

const ANSI_ESCAPE = String.fromCodePoint(0x1b);
const ANSI_PATTERN = new RegExp(
  String.raw`${ANSI_ESCAPE}\[[\d:;<=>?]*[\u0020-\u002F]*[\u0040-\u007E]`,
  'gu',
);
const CURSOR_UP_PATTERN = new RegExp(String.raw`${ANSI_ESCAPE}\[(\d+)A`, 'gu');
const CLEAR_FRAME_PATTERN = new RegExp(
  String.raw`\r?${ANSI_ESCAPE}\[\d+A${ANSI_ESCAPE}\[J`,
  'u',
);
const requireFromTest = createRequire(import.meta.url);
const green = (message: string): string => `\u001B[32m${message}\u001B[0m`;
const red = (message: string): string => `\u001B[31m${message}\u001B[0m`;
const yellow = (message: string): string => `\u001B[33m${message}\u001B[0m`;
const spinner = '⠋';

function createBufferedFlow(options: { forceTty?: boolean } = {}): {
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
      forceTty: options.forceTty ?? false,
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

function resolveTsxCliPath(): string {
  return requireFromTest.resolve('tsx/cli');
}

async function runFlowFixture(
  source: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<{
  stderr: string;
  stdout: string;
}> {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-flow-'));
  const fixturePath = path.join(rootDir, 'fixture.ts');

  await writeFile(fixturePath, source);

  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [resolveTsxCliPath(), fixturePath],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            ...options.env,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const stdout: string[] = [];
      const stderr: string[] = [];

      child.stdout.on('data', (chunk: Uint8Array) => {
        stdout.push(Buffer.from(chunk).toString());
      });
      child.stderr.on('data', (chunk: Uint8Array) => {
        stderr.push(Buffer.from(chunk).toString());
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve({
            stderr: stderr.join(''),
            stdout: stdout.join(''),
          });
          return;
        }

        reject(
          new Error(
            `Flow fixture exited with code ${code ?? 1}:\n${stderr.join('')}`,
          ),
        );
      });
    });
  } finally {
    await rm(rootDir, {
      force: true,
      recursive: true,
    });
  }
}

function getMaxCursorUpLineCount(output: string): number {
  return Math.max(
    0,
    ...Array.from(output.matchAll(CURSOR_UP_PATTERN), (match) =>
      Number(match[1]),
    ),
  );
}

function stripAnsi(output: string): string {
  return output.replaceAll(ANSI_PATTERN, '');
}

function getLastRenderedFrame(output: string): string {
  return stripAnsi(output.split(CLEAR_FRAME_PATTERN).at(-1) ?? '');
}

describe('LiminaFlowReporter', () => {
  it('writes stable plain text outside TTY mode', () => {
    const { chunks, flow } = createBufferedFlow();

    flow.intro('limina check');
    flow.start('graph check', { depth: 1 });
    flow.pass('graph check', { depth: 1, elapsedTimeMs: 120 });
    flow.fail('proof check', {
      depth: 1,
      error: new Error('first line\nsecond line'),
    });
    flow.skip('checker:typecheck', { depth: 1 });
    flow.outro('limina check failed');

    expect(chunks).toEqual([
      '[start] limina check\n',
      '  [start] graph check\n',
      '  [pass] graph check (120ms)\n',
      '  [fail] proof check: first line second line\n',
      '  [skip] checker:typecheck\n',
      '[done] limina check failed\n',
    ]);
  });

  it('writes stable plain text for dumb TTY terminals', () => {
    const chunks: string[] = [];
    const flow = createLiminaCheckFlowReporter({
      env: {
        TERM: 'dumb',
      },
      output: {
        write: (message) => {
          chunks.push(message);
        },
      },
      stdout: {
        isTTY: true,
      },
    });

    flow.intro('limina check');
    const task = flow.start('default check');
    task.pass('default check', { elapsedTimeMs: 1000 });
    flow.outro('limina check passed');

    expect(flow.interactive).toBe(false);
    expect(flow.rendererBackend).toBe('inline');
    expect(chunks).toEqual([
      '[start] limina check\n',
      '[start] default check\n',
      '[pass] default check (1.00s)\n',
      '[done] limina check passed\n',
    ]);
  });

  it('writes stable plain text for Codex captured terminals', () => {
    const chunks: string[] = [];
    const flow = createLiminaCheckFlowReporter({
      env: {
        CODEX_CI: '1',
        TERM: 'xterm-256color',
      },
      output: {
        write: (message) => {
          chunks.push(message);
        },
      },
      stdout: {
        isTTY: true,
      },
    });

    flow.intro('limina check');
    const task = flow.start('default check');
    task.pass('default check', { elapsedTimeMs: 1000 });
    flow.outro('limina check passed');

    expect(flow.interactive).toBe(false);
    expect(flow.rendererBackend).toBe('inline');
    expect(chunks).toEqual([
      '[start] limina check\n',
      '[start] default check\n',
      '[pass] default check (1.00s)\n',
      '[done] limina check passed\n',
    ]);
  });

  it('uses process renderer only for real TTY output by default', async () => {
    const inlineFlow = createLiminaCheckFlowReporter({
      env: {},
      forceTty: true,
      output: {
        write: () => {},
      },
    });

    expect(inlineFlow.rendererBackend).toBe('inline');

    const processFlow = createLiminaCheckFlowReporter({
      env: {},
      forceTty: true,
    });

    expect(processFlow.rendererBackend).toBe('process');
    await processFlow.close();
  });

  it('keeps spinner frames moving while the main process is busy', async () => {
    const flowModuleUrl = new URL('../flow.ts', import.meta.url).href;
    const { stdout } = await runFlowFixture(`
      import { createLiminaCheckFlowReporter } from ${JSON.stringify(flowModuleUrl)};

      void (async () => {
        const flow = createLiminaCheckFlowReporter({ forceTty: true });
        await flow.waitForRendererReady();
        flow.intro('limina check');
        const task = flow.start('default check', { collapseOnSuccess: false });
        await new Promise((resolve) => setTimeout(resolve, 180));
        const startedAt = Date.now();

        while (Date.now() - startedAt < 350) {}

        task.pass('default check', { elapsedTimeMs: 350 });
        flow.outro('limina check passed');
        await flow.close();
        process.stdout.write('\\nsummary after close\\n');
      })();
    `);
    const seenFrames = new Set(
      ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'].filter((frame) =>
        stdout.includes(`${frame}    default check`),
      ),
    );

    expect(seenFrames.size).toBeGreaterThan(1);
    expect(stdout).toContain(`${green('◆')}    default check (350ms)\n`);
    expect(stdout.lastIndexOf('summary after close')).toBeGreaterThan(
      stdout.lastIndexOf('limina check passed'),
    );
  });

  it('keeps process-rendered live frames within the terminal height', async () => {
    const flowModuleUrl = new URL('../flow.ts', import.meta.url).href;
    const { stdout } = await runFlowFixture(
      `
        import { createLiminaCheckFlowReporter } from ${JSON.stringify(flowModuleUrl)};

        void (async () => {
          const flow = createLiminaCheckFlowReporter({ forceTty: true });
          await flow.waitForRendererReady();
          flow.intro('limina check');
          const root = flow.tree('default check');
          const [graph, source, proof, checkerBuild, checkerTypecheck] = root.children([
            'graph check',
            'source check',
            'proof check',
            'checker build',
            'checker typecheck',
          ]);
          const [routes, references, conditions] = graph.children([
            'source graph routes',
            'project references',
            'condition domains',
          ]);
          const [projectRoutes, checkerCoverage] = proof.children([
            'project routes and configs',
            'checker coverage targets',
          ]);
          const [typescriptEntry, vueEntry] = checkerBuild.children([
            'typescript checker entry',
            'vue checker entry',
          ]);
          const [secondClassEntries] = checkerTypecheck.children([
            'second-class checker entries',
          ]);

          root.start();
          graph.start();
          routes.start();
          await new Promise((resolve) => setTimeout(resolve, 100));
          routes.fail(undefined, { elapsedTimeMs: 30 });
          references.pass(undefined, { elapsedTimeMs: 12 });
          conditions.pass(undefined, { elapsedTimeMs: 0 });
          graph.fail(undefined, { elapsedTimeMs: 200 });
          source.start();
          source.fail(undefined, { elapsedTimeMs: 300 });
          proof.start();
          projectRoutes.pass(undefined, { elapsedTimeMs: 36 });
          checkerCoverage.pass(undefined, { elapsedTimeMs: 0 });
          proof.pass(undefined, { elapsedTimeMs: 400 });
          checkerBuild.start();
          typescriptEntry.pass(undefined, { elapsedTimeMs: 427 });
          vueEntry.pass(undefined, { elapsedTimeMs: 427 });
          checkerBuild.pass(undefined, { elapsedTimeMs: 500 });
          checkerTypecheck.start();
          secondClassEntries.pass(undefined, { elapsedTimeMs: 0 });
          checkerTypecheck.pass(undefined, { elapsedTimeMs: 1 });
          root.fail(undefined, { elapsedTimeMs: 900 });
          flow.outro('limina check failed');
          await flow.close();
        })();
      `,
      {
        env: {
          LIMINA_FLOW_RENDERER_TEST_ROWS: '9',
        },
      },
    );

    const lastFrame = getLastRenderedFrame(stdout);

    expect(getMaxCursorUpLineCount(stdout)).toBeLessThanOrEqual(8);
    expect(lastFrame).toContain('┌  limina check\n');
    expect(lastFrame).toContain('✕    default check (900ms)\n');
    expect(lastFrame).toContain('✕      graph check (200ms)\n');
    expect(lastFrame).toContain('✕      source check (300ms)\n');
    expect(lastFrame).toContain('◆      checker build (500ms)\n');
    expect(lastFrame).toContain('└  limina check failed\n');
    expect(lastFrame).not.toContain('project routes and configs');
    expect(lastFrame).not.toContain('second-class checker entries');
  });

  it('compacts check-flow history to direct task states in short terminals', async () => {
    const flowModuleUrl = new URL('../flow.ts', import.meta.url).href;
    const { stdout } = await runFlowFixture(
      `
        import { createLiminaCheckFlowReporter } from ${JSON.stringify(flowModuleUrl)};

        void (async () => {
          const flow = createLiminaCheckFlowReporter({ forceTty: true });
          await flow.waitForRendererReady();
          flow.intro('limina check');

          const defaultCheck = flow.start('default check');
          const graph = flow.start('graph check', { depth: 1 });
          const graphRoute = flow.start('source graph routes', { depth: 2 });
          graphRoute.pass('source graph routes', { depth: 2, elapsedTimeMs: 35 });
          const projectReferences = flow.start('project references', { depth: 2 });
          projectReferences.pass('project references', { depth: 2, elapsedTimeMs: 14 });
          graph.pass('graph check', { depth: 1, elapsedTimeMs: 6850 });

          const source = flow.start('source check', { depth: 1 });
          const sourceRoute = flow.start('source graph routes', { depth: 2 });
          sourceRoute.pass('source graph routes', { depth: 2, elapsedTimeMs: 0 });
          const knip = flow.start('knip source usage', { depth: 2 });
          knip.pass('knip source usage', { depth: 2, elapsedTimeMs: 1260 });
          source.pass('source check', { depth: 1, elapsedTimeMs: 9310 });

          const proof = flow.start('proof check', { depth: 1 });
          const projectRoutes = flow.start('project routes and configs', { depth: 2 });
          projectRoutes.pass('project routes and configs', { depth: 2, elapsedTimeMs: 36 });
          proof.pass('proof check', { depth: 1, elapsedTimeMs: 5780 });

          const checkerBuild = flow.start('checker build', { depth: 1 });
          const typescriptEntry = flow.start('typescript checker entry', { depth: 2 });
          typescriptEntry.pass('typescript checker entry', { depth: 2, elapsedTimeMs: 8410 });
          checkerBuild.pass('checker build', { depth: 1, elapsedTimeMs: 14010 });

          const checkerTypecheck = flow.start('checker typecheck', { depth: 1 });
          const secondClassEntries = flow.start('second-class checker entries', { depth: 2 });
          secondClassEntries.pass('second-class checker entries', { depth: 2, elapsedTimeMs: 0 });
          checkerTypecheck.pass('checker typecheck', { depth: 1, elapsedTimeMs: 1 });

          defaultCheck.pass('default check', { elapsedTimeMs: 14120 });
          flow.outro('limina check passed');
          await flow.close();
        })();
      `,
      {
        env: {
          LIMINA_FLOW_RENDERER_TEST_ROWS: '9',
        },
      },
    );

    const lastFrame = getLastRenderedFrame(stdout);

    expect(getMaxCursorUpLineCount(stdout)).toBeLessThanOrEqual(8);
    expect(lastFrame).toContain('┌  limina check\n');
    expect(lastFrame).toContain('◆    default check (14.12s)\n');
    expect(lastFrame).toContain('◆      graph check (6.85s)\n');
    expect(lastFrame).toContain('◆      source check (9.31s)\n');
    expect(lastFrame).toContain('◆      proof check (5.78s)\n');
    expect(lastFrame).toContain('◆      checker build (14.01s)\n');
    expect(lastFrame).toContain('│  ...\n');
    expect(lastFrame).toContain('└  limina check passed\n');
    expect(lastFrame).not.toContain('source graph routes');
    expect(lastFrame).not.toContain('project routes and configs');
    expect(lastFrame).not.toContain('second-class checker entries');
  });

  it('compacts process-rendered final check-flow frames when terminal rows are unavailable', async () => {
    const flowModuleUrl = new URL('../flow.ts', import.meta.url).href;
    const { stdout } = await runFlowFixture(`
      import { createLiminaCheckFlowReporter } from ${JSON.stringify(flowModuleUrl)};

      void (async () => {
        const flow = createLiminaCheckFlowReporter({ forceTty: true });
        await flow.waitForRendererReady();
        flow.intro('limina check');

        const defaultCheck = flow.start('default check');
        const graph = flow.start('graph check', { depth: 1 });
        const graphRoute = flow.start('source graph routes', { depth: 2 });
        graphRoute.pass('source graph routes', { depth: 2, elapsedTimeMs: 489 });
        graph.pass('graph check', { depth: 1, elapsedTimeMs: 3870 });

        const source = flow.start('source check', { depth: 1 });
        source.pass('source check', { depth: 1, elapsedTimeMs: 8840 });

        defaultCheck.pass('default check', { elapsedTimeMs: 8870 });
        flow.outro('limina check passed');
        await flow.close();
      })();
    `);

    const lastFrame = getLastRenderedFrame(stdout);

    expect(lastFrame).toContain('┌  limina check\n');
    expect(lastFrame).toContain('◆    default check (8.87s)\n');
    expect(lastFrame).toContain('◆      graph check (3.87s)\n');
    expect(lastFrame).toContain('◆      source check (8.84s)\n');
    expect(lastFrame).toContain('│  ...\n');
    expect(lastFrame).toContain('└  limina check passed\n');
    expect(lastFrame).not.toContain('source graph routes');
  });

  it('compacts inline check-flow history with the outro in short terminals', () => {
    const chunks: string[] = [];
    const flow = createLiminaCheckFlowReporter({
      clack: {
        intro: () => {},
        log: {
          error: () => {},
          info: () => {},
          step: () => {},
          success: () => {},
          warn: () => {},
        },
        outro: () => {},
      },
      env: {},
      forceTty: true,
      output: {
        write: (message) => {
          chunks.push(message);
        },
      },
      renderer: 'inline',
      stdout: {
        columns: 80,
        isTTY: true,
        rows: 9,
      },
    });

    flow.intro('limina check');
    const defaultCheck = flow.start('default check');
    const graph = flow.start('graph check', { depth: 1 });
    const graphRoute = flow.start('source graph routes', { depth: 2 });
    graphRoute.pass('source graph routes', {
      depth: 2,
      elapsedTimeMs: 475,
    });
    const projectReferences = flow.start('project references', { depth: 2 });
    projectReferences.pass('project references', {
      depth: 2,
      elapsedTimeMs: 21,
    });
    const conditionDomains = flow.start('condition domains', { depth: 2 });
    conditionDomains.pass('condition domains', {
      depth: 2,
      elapsedTimeMs: 0,
    });
    const referenceCompleteness = flow.start('reference completeness', {
      depth: 2,
    });
    referenceCompleteness.pass('reference completeness', {
      depth: 2,
      elapsedTimeMs: 687,
    });
    graph.pass('graph check', { depth: 1, elapsedTimeMs: 3630 });

    const source = flow.start('source check', { depth: 1 });
    source.pass('source check', { depth: 1, elapsedTimeMs: 8650 });
    const proof = flow.start('proof check', { depth: 1 });
    proof.pass('proof check', { depth: 1, elapsedTimeMs: 4280 });
    const checkerBuild = flow.start('checker build', { depth: 1 });
    checkerBuild.pass('checker build', { depth: 1, elapsedTimeMs: 2620 });
    const checkerTypecheck = flow.start('checker typecheck', { depth: 1 });
    checkerTypecheck.pass('checker typecheck', {
      depth: 1,
      elapsedTimeMs: 1,
    });
    defaultCheck.pass('default check', { elapsedTimeMs: 8680 });
    flow.outro('limina check passed');

    const lastFrame = getLastRenderedFrame(chunks.join(''));

    expect(getMaxCursorUpLineCount(chunks.join(''))).toBeLessThanOrEqual(9);
    expect(lastFrame).toContain('┌  limina check\n');
    expect(lastFrame).toContain('◆    default check (8.68s)\n');
    expect(lastFrame).toContain('◆      graph check (3.63s)\n');
    expect(lastFrame).toContain('◆      source check (8.65s)\n');
    expect(lastFrame).toContain('◆      proof check (4.28s)\n');
    expect(lastFrame).toContain('◆      checker build (2.62s)\n');
    expect(lastFrame).toContain('│  ...\n');
    expect(lastFrame).toContain('└  limina check passed\n');
    expect(lastFrame).not.toContain('source graph routes');
    expect(lastFrame).not.toContain('project references');
    expect(lastFrame).not.toContain('condition domains');
    expect(lastFrame).not.toContain('reference completeness');
    expect(lastFrame).not.toContain('\n│\n└  limina check passed');
  });

  it('marks height-clipped check-flow tree frames as omitted', () => {
    const chunks: string[] = [];
    const flow = createLiminaCheckFlowReporter({
      clack: {
        intro: () => {},
        log: {
          error: () => {},
          info: () => {},
          step: () => {},
          success: () => {},
          warn: () => {},
        },
        outro: () => {},
      },
      env: {},
      forceTty: true,
      output: {
        write: (message) => {
          chunks.push(message);
        },
      },
      renderer: 'inline',
      stdout: {
        columns: 160,
        isTTY: true,
        rows: 9,
      },
    });

    flow.intro('limina check');
    const defaultCheck = flow.start('default check');
    const graph = flow.tree('graph check', { depth: 1 });
    const [
      graphRoute,
      projectReferences,
      conditionDomains,
      referenceCompleteness,
    ] = graph.children([
      'source graph routes',
      'project references',
      'condition domains',
      'reference completeness',
    ]);
    const source = flow.tree('source check', { depth: 1 });
    const [sourceRoute, tsconfigGovernance] = source.children([
      'source graph routes',
      'tsconfig governance',
    ]);
    const proof = flow.tree('proof check', { depth: 1 });
    const checkerBuild = flow.tree('checker build', { depth: 1 });
    const checkerTypecheck = flow.tree('checker typecheck', { depth: 1 });

    graph.start();
    graphRoute.pass(undefined, { elapsedTimeMs: 711 });
    projectReferences.pass(undefined, { elapsedTimeMs: 12 });
    conditionDomains.pass(undefined, { elapsedTimeMs: 0 });
    referenceCompleteness.pass(undefined, { elapsedTimeMs: 760 });
    graph.pass(undefined, { elapsedTimeMs: 4580 });
    source.start();
    sourceRoute.pass(undefined, { elapsedTimeMs: 0 });
    tsconfigGovernance.pass(undefined, { elapsedTimeMs: 0 });
    source.pass(undefined, { elapsedTimeMs: 9740 });
    proof.start();
    proof.pass(undefined, { elapsedTimeMs: 1230 });
    checkerBuild.start();
    checkerBuild.pass(undefined, { elapsedTimeMs: 2340 });
    checkerTypecheck.start();
    checkerTypecheck.pass(undefined, { elapsedTimeMs: 100 });
    defaultCheck.pass('default check', { elapsedTimeMs: 9770 });
    flow.outro('limina check passed');

    const lastFrame = getLastRenderedFrame(chunks.join(''));

    expect(lastFrame).toContain('┌  limina check\n');
    expect(lastFrame).toContain('◆    default check (9.77s)\n');
    expect(lastFrame).toContain('◆      graph check (4.58s)\n');
    expect(lastFrame).toContain('│  ...\n');
    expect(lastFrame).toContain('└  limina check passed\n');
    expect(lastFrame.indexOf('│  ...')).toBeLessThan(
      lastFrame.indexOf('└  limina check passed'),
    );
    expect(lastFrame).not.toContain('checker typecheck');
  });

  it('compacts the final check-flow frame when terminal rows are unavailable', () => {
    const chunks: string[] = [];
    const flow = createLiminaCheckFlowReporter({
      clack: {
        intro: () => {},
        log: {
          error: () => {},
          info: () => {},
          step: () => {},
          success: () => {},
          warn: () => {},
        },
        outro: () => {},
      },
      env: {},
      forceTty: true,
      output: {
        write: (message) => {
          chunks.push(message);
        },
      },
      renderer: 'inline',
      stdout: {
        columns: 80,
        isTTY: true,
      },
    });

    flow.intro('limina check');
    const defaultCheck = flow.start('default check');
    const graph = flow.start('graph check', { depth: 1 });
    const graphRoute = flow.start('source graph routes', { depth: 2 });
    graphRoute.pass('source graph routes', {
      depth: 2,
      elapsedTimeMs: 489,
    });
    graph.pass('graph check', { depth: 1, elapsedTimeMs: 3870 });
    const source = flow.start('source check', { depth: 1 });
    source.pass('source check', { depth: 1, elapsedTimeMs: 8840 });
    defaultCheck.pass('default check', { elapsedTimeMs: 8870 });
    flow.outro('limina check passed');

    const lastFrame = getLastRenderedFrame(chunks.join(''));

    expect(lastFrame).toContain('┌  limina check\n');
    expect(lastFrame).toContain('◆    default check (8.87s)\n');
    expect(lastFrame).toContain('◆      graph check (3.87s)\n');
    expect(lastFrame).toContain('◆      source check (8.84s)\n');
    expect(lastFrame).toContain('└  limina check passed\n');
    expect(lastFrame).not.toContain('source graph routes');
  });

  it('falls back to inline final output when the process renderer exits', async () => {
    const flowModuleUrl = new URL('../flow.ts', import.meta.url).href;
    const { stdout } = await runFlowFixture(
      `
        import { createLiminaCheckFlowReporter } from ${JSON.stringify(flowModuleUrl)};

        void (async () => {
          const flow = createLiminaCheckFlowReporter({ forceTty: true });
          flow.intro('limina check');
          const task = flow.start('default check', { collapseOnSuccess: false });
          task.pass('default check', { elapsedTimeMs: 123 });
          flow.outro('limina check passed');
          await flow.close();
          process.stdout.write('\\nsummary after fallback\\n');
        })();
      `,
      {
        env: {
          LIMINA_FLOW_RENDERER_TEST_CRASH: '1',
        },
      },
    );

    expect(stdout).toContain(`${green('◆')}    default check (123ms)\n`);
    expect(stdout).toContain('summary after fallback');
  });

  it('collapses successful task details in TTY mode', () => {
    const calls: string[] = [];
    const chunks: string[] = [];
    const flow = new LiminaFlowReporter({
      clack: {
        intro: (message) => calls.push(`intro:${message}`),
        log: {
          error: (message) => calls.push(`unused-error:${message}`),
          info: (message) => calls.push(`unused-info:${message}`),
          step: (message) => calls.push(`unused-step:${message}`),
          success: (message) => calls.push(`unused-success:${message}`),
          warn: (message) => calls.push(`unused-warn:${message}`),
        },
        outro: (message) => calls.push(`outro:${message}`),
      },
      env: {},
      forceTty: true,
      output: {
        write: (message) => {
          chunks.push(message);
        },
      },
      stdout: {
        columns: 80,
        isTTY: true,
      },
    });

    flow.intro('limina checker typecheck');
    const task = flow.start('proof check');
    task.info('proof check started');
    task.pass('proof check', { elapsedTimeMs: 1000 });
    flow.outro('limina checker passed');

    expect(calls).toEqual([
      'intro:limina checker typecheck',
      'outro:limina checker passed',
    ]);
    expect(chunks).toEqual([
      `${spinner}    proof check\n`,
      '│      proof check started\n',
      '\r\u001B[3A\u001B[J',
      '┌  limina checker typecheck\n',
      `${green('◆')}    proof check (1.00s)\n`,
    ]);
  });

  it('collapses process stdout writes emitted while a TTY task runs', () => {
    const chunks: string[] = [];
    const stdout = {
      columns: 80,
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
    const flow = new LiminaFlowReporter({
      env: {},
      forceTty: true,
      stdout,
    });

    const task = flow.start('proof check');
    stdout.write('limina[task.proof]: proof check started\n');
    task.pass('proof check', { elapsedTimeMs: 1000 });

    expect(chunks).toEqual([
      `${spinner}    proof check\n`,
      'limina[task.proof]: proof check started\n',
      '\r\u001B[2A\u001B[J',
      `${green('◆')}    proof check (1.00s)\n`,
    ]);
  });

  it('redraws successful top-level tasks without nested task details', () => {
    const chunks: string[] = [];
    const flow = new LiminaFlowReporter({
      env: {},
      forceTty: true,
      output: {
        write: (message) => {
          chunks.push(message);
        },
      },
      stdout: {
        columns: 80,
        isTTY: true,
      },
    });

    flow.start('pipeline: typecheck', { collapseOnSuccess: false });
    const task = flow.start('tsc check');
    const target = flow.start('tsc: tsconfig.lib.json', {
      collapseOnSuccess: false,
      depth: 1,
    });
    target.pass('tsc: tsconfig.lib.json', { depth: 1, elapsedTimeMs: 1000 });
    task.pass('tsc check', { elapsedTimeMs: 2000 });

    expect(chunks).toEqual([
      `${spinner}    pipeline: typecheck\n`,
      `${spinner}    tsc check\n`,
      `${spinner}      tsc: tsconfig.lib.json\n`,
      `${green('◆')}      tsc: tsconfig.lib.json (1.00s)\n`,
      '\r\u001B[4A\u001B[J',
      `${spinner}    pipeline: typecheck\n`,
      `${green('◆')}    tsc check (2.00s)\n`,
    ]);
  });

  it('redraws persisted start lines before tree nodes exist', () => {
    vi.useFakeTimers();

    try {
      const chunks: string[] = [];
      const flow = new LiminaFlowReporter({
        env: {},
        forceTty: true,
        output: {
          write: (message) => {
            chunks.push(message);
          },
        },
        stdout: {
          columns: 80,
          isTTY: true,
        },
      });

      flow.intro('limina check');
      const task = flow.start('default check', {
        collapseOnSuccess: false,
      });

      vi.advanceTimersByTime(80);

      expect(chunks.join('')).toContain('⠙    default check\n');

      task.pass('default check', { elapsedTimeMs: 1000 });

      expect(chunks.join('')).toContain(
        `${green('◆')}    default check (1.00s)\n`,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps inline live frames within the terminal height', () => {
    const chunks: string[] = [];
    const flow = new LiminaFlowReporter({
      clack: {
        intro: () => {},
        log: {
          error: () => {},
          info: () => {},
          step: () => {},
          success: () => {},
          warn: () => {},
        },
        outro: () => {},
      },
      env: {},
      forceTty: true,
      output: {
        write: (message) => {
          chunks.push(message);
        },
      },
      renderer: 'inline',
      stdout: {
        columns: 80,
        isTTY: true,
        rows: 4,
      },
    });

    flow.intro('limina check');
    const root = flow.tree('default check');
    const graph = root.child('graph check');
    const [routes, references, conditions] = graph.children([
      'source graph routes',
      'project references',
      'condition domains',
    ]);

    root.start();
    graph.start();
    routes.start();
    routes.fail(undefined, { elapsedTimeMs: 30 });
    references.pass(undefined, { elapsedTimeMs: 12 });
    conditions.pass(undefined, { elapsedTimeMs: 0 });
    graph.fail(undefined, { elapsedTimeMs: 200 });
    root.fail(undefined, { elapsedTimeMs: 220 });

    const output = chunks.join('');
    const lastFrame = getLastRenderedFrame(output);

    expect(getMaxCursorUpLineCount(output)).toBeLessThanOrEqual(3);
    expect(lastFrame).toContain('┌  limina check\n');
    expect(lastFrame).toContain('✕    default check (220ms)\n');
    expect(lastFrame).toContain('│  ...\n');
    expect(lastFrame).not.toContain('project references');
  });

  it('renders tree nodes with running and completed states', () => {
    const chunks: string[] = [];
    const flow = new LiminaFlowReporter({
      env: {},
      forceTty: true,
      output: {
        write: (message) => {
          chunks.push(message);
        },
      },
      stdout: {
        columns: 80,
        isTTY: true,
      },
    });

    const parent = flow.tree('default check');
    const source = parent.child('source check');

    parent.start();
    source.start();
    parent.pass(undefined, { elapsedTimeMs: 300 });

    const beforeChildFinishes = chunks.join('');

    expect(beforeChildFinishes).toContain('◇    default check\n');
    expect(beforeChildFinishes).toContain(`${spinner}      source check\n`);
    expect(beforeChildFinishes).toContain(`${green('◆')}    default check\n`);
    expect(beforeChildFinishes).not.toContain('default check (300ms)');

    source.pass(undefined, { elapsedTimeMs: 120 });

    const output = chunks.join('');

    expect(output).toContain(`${green('◆')}      source check (120ms)\n`);
    expect(output).toContain(`${green('◆')}    default check (300ms)\n`);
    expect(output).not.toContain('\u001B[H\u001B[2J\u001B[3J');
  });

  it('finishes parent tree nodes after skipping unstarted planned children', () => {
    const chunks: string[] = [];
    const flow = new LiminaFlowReporter({
      env: {},
      forceTty: true,
      output: {
        write: (message) => {
          chunks.push(message);
        },
      },
      stdout: {
        columns: 80,
        isTTY: true,
      },
    });

    const parent = flow.tree('graph check');
    const [routes] = parent.children([
      'source graph routes',
      'project references',
    ]);

    if (!routes) {
      throw new Error('Expected planned route check item.');
    }

    parent.start();
    routes.start();
    routes.pass(undefined, { elapsedTimeMs: 50 });
    parent.fail(undefined, { elapsedTimeMs: 300 });

    const output = chunks.join('');

    expect(output).toContain(`${green('◆')}      source graph routes (50ms)\n`);
    expect(output).toContain('◇      project references\n');
    expect(output).toContain(`${red('✕')}    graph check (300ms)\n`);
  });

  it('keeps persisted warnings in the final TTY history', () => {
    const chunks: string[] = [];
    const flow = new LiminaFlowReporter({
      env: {},
      forceTty: true,
      output: {
        write: (message) => {
          chunks.push(message);
        },
      },
      stdout: {
        columns: 80,
        isTTY: true,
      },
    });

    flow.intro('limina check');
    const task = flow.start('checker build');
    flow.warn('cache warning', {
      depth: 1,
      persistInteractive: true,
    });
    task.pass('checker build', { elapsedTimeMs: 1000 });

    expect(chunks).toEqual([
      `${spinner}    checker build\n`,
      `${yellow('▲')}      cache warning\n`,
      '\r\u001B[3A\u001B[J',
      '┌  limina check\n',
      `${yellow('▲')}      cache warning\n`,
      `${green('◆')}    checker build (1.00s)\n`,
    ]);
  });

  it('keeps failed task details in TTY mode', () => {
    const chunks: string[] = [];
    const flow = new LiminaFlowReporter({
      env: {},
      forceTty: true,
      output: {
        write: (message) => {
          chunks.push(message);
        },
      },
      stdout: {
        columns: 80,
        isTTY: true,
      },
    });

    const task = flow.start('proof check');
    task.info('proof check started');
    task.fail('proof check failed', {
      elapsedTimeMs: 1000,
      error: new Error('bad proof'),
    });

    expect(chunks).toEqual([
      `${spinner}    proof check\n`,
      '│      proof check started\n',
      `${red('✕')}    proof check failed: bad proof (1.00s)\n`,
    ]);
  });

  it('writes only status lines in check-flow mode', () => {
    const chunks: string[] = [];
    const flow = createLiminaCheckFlowReporter({
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
    });

    flow.intro('limina check');
    const task = flow.start('graph check', { depth: 1 });
    task.info('graph check started');
    flow.warn('capability summary', { depth: 1 });
    flow.writeOutput('command detail\n');
    task.fail('graph check failed', {
      elapsedTimeMs: 1000,
      error: new Error('detailed failure'),
    });
    flow.outro('limina check failed');

    expect(chunks).toEqual([
      '[start] limina check\n',
      '  [start] graph check\n',
      '  [fail] graph check (1.00s)\n',
      '[done] limina check failed\n',
    ]);
  });

  it('does not clear the whole screen in check-flow TTY mode', () => {
    const chunks: string[] = [];
    const flow = createLiminaCheckFlowReporter({
      env: {},
      forceTty: true,
      output: {
        write: (message) => {
          chunks.push(message);
        },
      },
      stdout: {
        columns: 80,
        isTTY: true,
      },
    });

    flow.intro('limina check');
    const task = flow.start('source check');
    task.info('source check started');
    task.pass('source check', { elapsedTimeMs: 1000 });
    flow.outro('limina check passed');

    expect(chunks.join('')).not.toContain('\u001B[H\u001B[2J\u001B[3J');
    expect(chunks).toContain(`${green('◆')}    source check (1.00s)\n`);
  });

  it('replaces failed check-flow task start lines in TTY mode', () => {
    const chunks: string[] = [];
    const flow = createLiminaCheckFlowReporter({
      env: {},
      forceTty: true,
      output: {
        write: (message) => {
          chunks.push(message);
        },
      },
      stdout: {
        columns: 80,
        isTTY: true,
      },
    });

    flow.intro('limina check');
    const task = flow.start('source check');
    task.fail('source check failed', {
      elapsedTimeMs: 2970,
      error: new Error('detailed failure'),
    });
    flow.outro('limina check failed');

    const output = chunks.join('');

    expect(output).not.toContain('\u001B[H\u001B[2J\u001B[3J');
    expect(chunks).toContain(`${red('✕')}    source check (2.97s)\n`);
    expect(output).not.toContain('source check failed');
    expect(output).not.toContain('detailed failure');
  });
});
