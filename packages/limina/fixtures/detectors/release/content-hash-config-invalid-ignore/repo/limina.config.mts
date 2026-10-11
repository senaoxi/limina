export default {
  scope: {},
  package: {
    entries: [
      {
        checks: [],
        name: '@fixture/release-workspace',
        outDir: 'packages/root/dist',
      },
    ],
  },
  release: { contentHash: { ignore: () => [123] } },
  pipelines: {
    detector: ['release:check'],
  },
};
