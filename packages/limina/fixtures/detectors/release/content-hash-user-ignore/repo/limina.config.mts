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
  release: { contentHash: { ignore: ['generated.js'] } },
  pipelines: {
    detector: ['release:check'],
  },
};
