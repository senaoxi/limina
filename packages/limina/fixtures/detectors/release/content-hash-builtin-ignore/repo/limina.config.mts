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
  release: { contentHash: { builtinIgnore: true } },
  pipelines: {
    detector: ['release:check'],
  },
};
