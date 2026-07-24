import { expect, it } from 'vitest';

import {
  type DetectorFixtureCase,
  discoverDetectorFixtures,
} from './detector-fixture-discovery';
import { runDetectorFixture } from './detector-fixture-runner';

export async function loadDetectorFixtures(options: {
  readonly caseModules: ReadonlyMap<string, unknown>;
  readonly detectorRoot: string;
  readonly includeIdPrefixes: readonly string[];
}): Promise<readonly DetectorFixtureCase[]> {
  return discoverDetectorFixtures(options);
}

export function registerDetectorFixtures(
  fixtures: readonly DetectorFixtureCase[],
): void {
  for (const fixture of fixtures) {
    it(fixture.id, async () => {
      const result = await runDetectorFixture(fixture);

      expect(result.fixtureId).toBe(fixture.id);
      expect(result.preserved || result.cleaned).toBe(true);
    });
  }
}
