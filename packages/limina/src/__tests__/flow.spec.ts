import { describe, expect, it } from 'vitest';
import { LiminaFlowReporter } from '../flow';

const green = (message: string): string => `\u001B[32m${message}\u001B[0m`;
const red = (message: string): string => `\u001B[31m${message}\u001B[0m`;

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
      '◇    proof check\n',
      '│      proof check started\n',
      '\r\u001B[H\u001B[2J\u001B[3J',
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
      '◇    proof check\n',
      'limina[task.proof]: proof check started\n',
      '\r\u001B[H\u001B[2J\u001B[3J',
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
      '◇    pipeline: typecheck\n',
      '◇    tsc check\n',
      '◇      tsc: tsconfig.lib.json\n',
      `${green('◆')}      tsc: tsconfig.lib.json (1.00s)\n`,
      '\r\u001B[H\u001B[2J\u001B[3J',
      '◇    pipeline: typecheck\n',
      `${green('◆')}    tsc check (2.00s)\n`,
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
      '◇    proof check\n',
      '│      proof check started\n',
      `${red('■')}    proof check failed: bad proof (1.00s)\n`,
    ]);
  });
});
