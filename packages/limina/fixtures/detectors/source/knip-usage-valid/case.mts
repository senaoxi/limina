import { defineDetectorFixture } from '../../../../integration/helpers/detector-fixture-types';

export default defineDetectorFixture({
  command: ['check', 'detector'],
  expected: {
    additionalCodes: [],
    exitCode: 0,
    issues: [],
  },
  id: 'source/knip-usage-valid',
  kind: 'filesystem',
  setup: [
    {
      kind: 'directory-link',
      path: 'repo/packages/app/node_modules/@fixture/source-knip-valid-target',
      target: 'repo/packages/target',
    },
  ],
  tools: ['typescript'],
});
