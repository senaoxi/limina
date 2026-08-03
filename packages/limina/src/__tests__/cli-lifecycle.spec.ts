import type { cac } from 'cac';
import readline from 'node:readline';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeCli } from '../cli';
import * as cliFactory from '../cli/factory';
import { createCliFlow } from '../cli/flow';

interface TerminalDescriptors {
  isTTY: PropertyDescriptor | undefined;
  rows: PropertyDescriptor | undefined;
}

let descriptors: TerminalDescriptors;
let originalCI: string | undefined;
let originalCodexCI: string | undefined;
let originalTerm: string | undefined;

function setTerminal(options: {
  isTTY: boolean;
  rows: number | undefined;
}): void {
  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    value: options.isTTY,
  });
  Object.defineProperty(process.stdout, 'rows', {
    configurable: true,
    value: options.rows,
  });
}

function restoreProperty(
  target: object,
  key: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    delete (target as Record<string, unknown>)[key];
    return;
  }

  Object.defineProperty(target, key, descriptor);
}

function createFakeCli(options: {
  command: string;
  run: () => Promise<void>;
}): ReturnType<typeof cac> {
  return {
    args: [options.command],
    matchedCommand: {},
    parse: vi.fn(),
    runMatchedCommand: vi.fn(options.run),
  } as unknown as ReturnType<typeof cac>;
}

describe('CLI lifecycle screen clearing', () => {
  beforeEach(() => {
    descriptors = {
      isTTY: Object.getOwnPropertyDescriptor(process.stdout, 'isTTY'),
      rows: Object.getOwnPropertyDescriptor(process.stdout, 'rows'),
    };
    originalCI = process.env.CI;
    originalCodexCI = process.env.CODEX_CI;
    originalTerm = process.env.TERM;
    delete process.env.CI;
    delete process.env.CODEX_CI;
    delete process.env.TERM;
    setTerminal({ isTTY: true, rows: 24 });
  });

  afterEach(() => {
    if (originalCI === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCI;
    }
    if (originalCodexCI === undefined) {
      delete process.env.CODEX_CI;
    } else {
      process.env.CODEX_CI = originalCodexCI;
    }
    if (originalTerm === undefined) {
      delete process.env.TERM;
    } else {
      process.env.TERM = originalTerm;
    }
    restoreProperty(process.stdout, 'isTTY', descriptors.isTTY);
    restoreProperty(process.stdout, 'rows', descriptors.rows);
    vi.restoreAllMocks();
  });

  it.each(['migration', 'graph export'])(
    'clears once before the %s command action',
    async (command) => {
      const action = vi.fn().mockImplementation(async () => {});
      const cli = createFakeCli({ command, run: action });
      const createCli = vi
        .spyOn(cliFactory, 'createLiminaCli')
        .mockReturnValue(cli);
      const stdoutWrite = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);
      const cursorTo = vi
        .spyOn(readline, 'cursorTo')
        .mockImplementation(() => true);
      const clearScreenDown = vi
        .spyOn(readline, 'clearScreenDown')
        .mockImplementation(() => true);

      await executeCli(['node', 'limina', ...command.split(' ')]);

      expect(createCli).toHaveBeenCalledOnce();
      expect(action).toHaveBeenCalledOnce();
      expect(stdoutWrite).toHaveBeenCalledWith('\n'.repeat(22));
      expect(cursorTo).toHaveBeenCalledOnce();
      expect(clearScreenDown).toHaveBeenCalledOnce();
      expect(cursorTo.mock.invocationCallOrder[0]).toBeLessThan(
        action.mock.invocationCallOrder[0],
      );
    },
  );

  it('clears before issue filter help without creating a CLI action', async () => {
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const cursorTo = vi
      .spyOn(readline, 'cursorTo')
      .mockImplementation(() => true);
    const clearScreenDown = vi
      .spyOn(readline, 'clearScreenDown')
      .mockImplementation(() => true);

    await executeCli([
      'node',
      'limina',
      'check',
      '--issues',
      '--rule',
      '--help',
    ]);

    expect(stdoutWrite).toHaveBeenCalledWith('\n'.repeat(22));
    expect(cursorTo).toHaveBeenCalledOnce();
    expect(clearScreenDown).toHaveBeenCalledOnce();
    expect(stdoutWrite.mock.calls.at(-1)?.[0]).toContain(
      'Supported check issue rules:',
    );
  });

  it('clears before argument validation errors', async () => {
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const cursorTo = vi
      .spyOn(readline, 'cursorTo')
      .mockImplementation(() => true);
    const clearScreenDown = vi
      .spyOn(readline, 'clearScreenDown')
      .mockImplementation(() => true);

    await expect(
      executeCli(['node', 'limina', 'check', '--issues', '--limit', '0']),
    ).rejects.toThrow();

    expect(stdoutWrite).toHaveBeenCalledWith('\n'.repeat(22));
    expect(cursorTo).toHaveBeenCalledOnce();
    expect(clearScreenDown).toHaveBeenCalledOnce();
  });

  it('does not add terminal control output to non-TTY machine output', async () => {
    setTerminal({ isTTY: false, rows: 24 });
    const action = vi.fn(async () => {
      process.stdout.write('{"ok":true}\n');
    });
    const cli = createFakeCli({ command: 'graph', run: action });
    vi.spyOn(cliFactory, 'createLiminaCli').mockReturnValue(cli);
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const cursorTo = vi
      .spyOn(readline, 'cursorTo')
      .mockImplementation(() => true);
    const clearScreenDown = vi
      .spyOn(readline, 'clearScreenDown')
      .mockImplementation(() => true);

    await executeCli(['node', 'limina', 'graph']);

    expect(cursorTo).not.toHaveBeenCalled();
    expect(clearScreenDown).not.toHaveBeenCalled();
    expect(stdoutWrite).toHaveBeenCalledWith('{"ok":true}\n');
    expect(
      stdoutWrite.mock.calls.some(([value]) => value === '\n'.repeat(22)),
    ).toBe(false);
  });

  it('does not clear a Codex-captured TTY before the command action', async () => {
    process.env.CODEX_CI = '1';
    const action = vi.fn().mockImplementation(async () => {});
    const cli = createFakeCli({ command: 'graph', run: action });
    vi.spyOn(cliFactory, 'createLiminaCli').mockReturnValue(cli);
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const cursorTo = vi
      .spyOn(readline, 'cursorTo')
      .mockImplementation(() => true);
    const clearScreenDown = vi
      .spyOn(readline, 'clearScreenDown')
      .mockImplementation(() => true);

    await executeCli(['node', 'limina', 'graph']);

    expect(action).toHaveBeenCalledOnce();
    expect(stdoutWrite).not.toHaveBeenCalledWith('\n'.repeat(22));
    expect(cursorTo).not.toHaveBeenCalled();
    expect(clearScreenDown).not.toHaveBeenCalled();
  });

  it('does not clear when only creating a Flow reporter', () => {
    const cursorTo = vi
      .spyOn(readline, 'cursorTo')
      .mockImplementation(() => true);
    const clearScreenDown = vi
      .spyOn(readline, 'clearScreenDown')
      .mockImplementation(() => true);

    createCliFlow();

    expect(cursorTo).not.toHaveBeenCalled();
    expect(clearScreenDown).not.toHaveBeenCalled();
  });
});
