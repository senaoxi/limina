export default {
  config: {},
  package: {
    entries: [
      {
        checks: [],
        name: '@fixture/release-workspace',
        outDir: 'packages/root/dist',
      },
    ],
  },
  pipelines: {
    detector: ['release:check'],
  },
  release: { npmPackageJsonLint: true },
};
