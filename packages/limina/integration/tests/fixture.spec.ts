import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { toPortableRelativePath } from '../../src/__tests__/helpers/path';
import { type PreparedFixture, prepareFixture } from '../helpers/fixture';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const fixtureState: { current: PreparedFixture | undefined } = {
  current: undefined,
};

afterEach(async () => {
  await fixtureState.current?.cleanup();
  fixtureState.current = undefined;
});

describe('integration fixture runtime directory', () => {
  it('creates isolated fixtures under .limina/integration', async () => {
    fixtureState.current = await prepareFixture('project-references');

    expect(
      toPortableRelativePath(repoRoot, fixtureState.current.runtimeDir),
    ).toMatch(
      /^\.limina\/integration\/limina-integration-project-references-[^/]+$/u,
    );
  });
});
