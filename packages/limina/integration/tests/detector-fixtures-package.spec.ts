/// <reference types="vite/client" />

import { fileURLToPath } from 'node:url';
import { describe } from 'vitest';

import {
  loadDetectorFixtures,
  registerDetectorFixtures,
} from '../helpers/detector-fixture-suite';

const detectorRoot = fileURLToPath(
  new URL('../../fixtures/detectors/', import.meta.url),
);
const caseModules = new Map(
  Object.entries(
    import.meta.glob('../../fixtures/detectors/package/**/case.mts', {
      eager: true,
    }),
  ).map(([specifier, caseModule]) => [
    fileURLToPath(new URL(specifier, import.meta.url)),
    caseModule,
  ]),
);

const fixtures = await loadDetectorFixtures({
  caseModules,
  detectorRoot,
  includeIdPrefixes: ['package/'],
});

describe('declarative package detector fixtures', () => {
  registerDetectorFixtures(fixtures);
});
