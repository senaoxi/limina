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
    import.meta.glob(
      '../../fixtures/detectors/{checker,graph,proof,source,workspace}/**/case.mts',
      { eager: true },
    ),
  ).map(([specifier, caseModule]) => [
    fileURLToPath(new URL(specifier, import.meta.url)),
    caseModule,
  ]),
);

const fixtures = await loadDetectorFixtures({
  caseModules,
  detectorRoot,
  includeIdPrefixes: ['checker/', 'graph/', 'proof/', 'source/', 'workspace/'],
});

describe('declarative core detector fixtures', () => {
  registerDetectorFixtures(fixtures);
});
