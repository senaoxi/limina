import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'pathe';
import { describe, expect, it, vi } from 'vitest';
import { createLiminaCheckFlowReporter, LiminaFlowReporter } from '../flow';

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

function resolveTsxBinary(): string {
  const tsxBinName = process.platform === 'win32' ? 'tsx.cmd' : 'tsx';

  return (
    [
      path.join(process.cwd(), 'node_modules/.bin', tsxBinName),
      path.join(process.cwd(), '../../node_modules/.bin', tsxBinName),
    ].find((candidate) => existsSync(candidate)) ?? 'tsx'
  );
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
      const child = spawn(resolveTsxBinary(), [fixturePath], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...options.env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
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
        await new Promise((resolve) => setImmediate(resolve));
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
      write: (message: string) => {
        chunks.push(message);
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
