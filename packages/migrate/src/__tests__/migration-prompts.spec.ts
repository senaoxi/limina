import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isConfirmDirtyWorkspace,
  isConfirmMigrationScope,
  selectHardlinkStrategy,
} from '../migration/prompts';

const selectMock = vi.hoisted(() => vi.fn());
const confirmMock = vi.hoisted(() => vi.fn());

vi.mock('@clack/prompts', () => ({
  confirm: confirmMock,
  isCancel: (value: unknown) => typeof value === 'symbol',
  select: selectMock,
}));

function setTty(isValue: boolean): () => void {
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
    value: isValue,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    value: isValue,
  });

  return () => {
    if (stdinDescriptor === undefined) {
      delete (process.stdin as Partial<typeof process.stdin>).isTTY;
    } else {
      Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
    }
    if (stdoutDescriptor === undefined) {
      delete (process.stdout as Partial<typeof process.stdout>).isTTY;
    } else {
      Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
    }
  };
}

const ttyState: { restore?: () => void } = {};

afterEach(() => {
  ttyState.restore?.();
  ttyState.restore = undefined;
  selectMock.mockReset();
  confirmMock.mockReset();
});

describe('migration prompts', () => {
  it('defaults only the scope confirmation to Yes and treats cancellation as refusal', async () => {
    ttyState.restore = setTty(true);
    confirmMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(Symbol('cancel'));
    await expect(isConfirmMigrationScope('scope')).resolves.toBe(true);
    await expect(isConfirmDirtyWorkspace('dirty')).resolves.toBe(false);
    await expect(isConfirmMigrationScope('scope')).resolves.toBe(false);
    expect(confirmMock.mock.calls).toEqual([
      [{ initialValue: true, message: 'scope' }],
      [{ initialValue: false, message: 'dirty' }],
      [{ initialValue: true, message: 'scope' }],
    ]);
  });
  it('requires explicit scope acceptance in non-TTY environments without opening a prompt', async () => {
    ttyState.restore = setTty(false);
    await expect(isConfirmMigrationScope('scope')).rejects.toThrow('Use --yes');
    expect(confirmMock).not.toHaveBeenCalled();
  });
  it('selects in-place hardlink rewrite by default', async () => {
    ttyState.restore = setTty(true);
    selectMock.mockResolvedValue('rewrite');

    await expect(selectHardlinkStrategy('choose a strategy')).resolves.toBe(
      'rewrite',
    );
    expect(selectMock).toHaveBeenCalledWith({
      initialValue: 'rewrite',
      message: 'choose a strategy',
      options: [
        {
          label: 'Rewrite hard-linked files in place',
          value: 'rewrite',
        },
        {
          label: 'Skip hard-linked files and migrate the rest',
          value: 'skip',
        },
        { label: 'Cancel migration', value: 'cancel' },
      ],
    });
  });
});
