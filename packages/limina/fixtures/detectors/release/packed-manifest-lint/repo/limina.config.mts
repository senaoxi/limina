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
  release: { npmPackageJsonLint: true },
  pipelines: {
    detector: ['release:check'],
  },
};
