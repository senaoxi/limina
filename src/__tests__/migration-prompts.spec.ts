import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectHardlinkStrategy } from '../commands/migration/prompts';

const selectMock = vi.hoisted(() => vi.fn());

vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(),
  isCancel: (value: unknown) => typeof value === 'symbol',
  select: selectMock,
}));

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

let restoreTty: (() => void) | undefined;

afterEach(() => {
  restoreTty?.();
  restoreTty = undefined;
  selectMock.mockReset();
});

describe('migration prompts', () => {
  it('selects in-place hardlink rewrite by default', async () => {
    restoreTty = setTty(true);
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
