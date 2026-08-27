import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { toPortableRelativePath } from '../../src/__tests__/helpers/path';
import { type PreparedFixture, prepareFixture } from '../helpers/fixture';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

let fixture: PreparedFixture | undefined;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

describe('integration fixture runtime directory', () => {
  it('creates isolated fixtures under .limina/integration', async () => {
    fixture = await prepareFixture('project-references');

    expect(toPortableRelativePath(repositoryRoot, fixture.runtimeDir)).toMatch(
      /^\.limina\/integration\/limina-integration-project-references-[^/]+$/u,
    );
  });
});
