import readline from 'node:readline';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCliScreen } from '../logger';

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

describe('clearCliScreen', () => {
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

  it('keeps the current shell command on the first row', () => {
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const cursorTo = vi
      .spyOn(readline, 'cursorTo')
      .mockImplementation(() => true);
    const clearScreenDown = vi
      .spyOn(readline, 'clearScreenDown')
      .mockImplementation(() => true);

    clearCliScreen();

    expect(stdoutWrite).toHaveBeenCalledWith('\n'.repeat(22));
    expect(cursorTo).toHaveBeenCalledWith(process.stdout, 0, 1);
    expect(clearScreenDown).toHaveBeenCalledWith(process.stdout);
    expect(stdoutWrite.mock.invocationCallOrder[0]).toBeLessThan(
      cursorTo.mock.invocationCallOrder[0],
    );
    expect(cursorTo.mock.invocationCallOrder[0]).toBeLessThan(
      clearScreenDown.mock.invocationCallOrder[0],
    );
  });

  it('does not write padding for a two-row terminal', () => {
    setTerminal({ isTTY: true, rows: 2 });
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const cursorTo = vi
      .spyOn(readline, 'cursorTo')
      .mockImplementation(() => true);
    const clearScreenDown = vi
      .spyOn(readline, 'clearScreenDown')
      .mockImplementation(() => true);

    clearCliScreen();

    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(cursorTo).toHaveBeenCalledWith(process.stdout, 0, 1);
    expect(clearScreenDown).toHaveBeenCalledWith(process.stdout);
  });

  it.each([
    { label: 'non-TTY output', isTTY: false, rows: 24 },
    { label: 'CI=1 output', isTTY: true, rows: 24, ci: '1' },
    { label: 'CI=true output', isTTY: true, rows: 24, ci: 'true' },
    {
      label: 'CODEX_CI=1 output',
      isTTY: true,
      rows: 24,
      codexCI: '1',
    },
    {
      label: 'CODEX_CI=true output',
      isTTY: true,
      rows: 24,
      codexCI: 'true',
    },
    { label: 'TERM=dumb output', isTTY: true, rows: 24, term: 'dumb' },
    { label: 'unknown terminal height', isTTY: true, rows: undefined },
    { label: 'zero terminal height', isTTY: true, rows: 0 },
    { label: 'one-row terminal', isTTY: true, rows: 1 },
    { label: 'fractional terminal height', isTTY: true, rows: 2.5 },
    { label: 'NaN terminal height', isTTY: true, rows: Number.NaN },
  ])('skips clearing for $label', ({ ci, codexCI, isTTY, rows, term }) => {
    setTerminal({ isTTY, rows });
    if (ci !== undefined) {
      process.env.CI = ci;
    }
    if (codexCI !== undefined) {
      process.env.CODEX_CI = codexCI;
    }
    if (term !== undefined) {
      process.env.TERM = term;
    }
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const cursorTo = vi
      .spyOn(readline, 'cursorTo')
      .mockImplementation(() => true);
    const clearScreenDown = vi
      .spyOn(readline, 'clearScreenDown')
      .mockImplementation(() => true);

    clearCliScreen();

    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(cursorTo).not.toHaveBeenCalled();
    expect(clearScreenDown).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'CI=false', ci: 'false' },
    { label: 'CODEX_CI=false', codexCI: 'false' },
  ])('does not treat $label as captured output', ({ ci, codexCI }) => {
    if (ci !== undefined) {
      process.env.CI = ci;
    }
    if (codexCI !== undefined) {
      process.env.CODEX_CI = codexCI;
    }
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const cursorTo = vi
      .spyOn(readline, 'cursorTo')
      .mockImplementation(() => true);
    const clearScreenDown = vi
      .spyOn(readline, 'clearScreenDown')
      .mockImplementation(() => true);

    clearCliScreen();

    expect(stdoutWrite).toHaveBeenCalledWith('\n'.repeat(22));
    expect(cursorTo).toHaveBeenCalledWith(process.stdout, 0, 1);
    expect(clearScreenDown).toHaveBeenCalledWith(process.stdout);
  });
});
