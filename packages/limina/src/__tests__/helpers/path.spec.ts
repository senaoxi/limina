import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFixturePathResolver, toPortablePath } from './path';

describe('portable test paths', () => {
  it('resolves fixture paths with portable separators', () => {
    const fixturePath = createFixturePathResolver(String.raw`C:\repo`);

    expect(fixturePath()).toBe('C:/repo');
    expect(fixturePath('packages', 'a')).toBe('C:/repo/packages/a');
  });

  it('normalizes Windows path strings on every platform', () => {
    expect(toPortablePath(path.win32.join('C:\\repo', 'packages', 'a'))).toBe(
      'C:/repo/packages/a',
    );
  });
});
