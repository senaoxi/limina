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
  release: { contentHash: { baselineTag: () => '' } },
  pipelines: {
    detector: ['release:check'],
  },
};
