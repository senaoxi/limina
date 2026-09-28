export default {
  package: {
    entries: [
      {
        checks: ['boundary'],
        name: '@fixture/manifest-local-workspace',
        outDir: 'package-output',
      },
    ],
  },
  pipelines: {
    detector: ['package:check'],
  },
};
