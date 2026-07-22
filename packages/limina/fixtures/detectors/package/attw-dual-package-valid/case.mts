import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';

export default defineDetectorFixture({
  command: ['check', 'detector'],
  expected: {
    additionalCodes: [],
    exitCode: 0,
    issues: [],
  },
  id: 'package/attw-dual-package-valid',
  kind: 'external-tool',
  tools: [],
});
