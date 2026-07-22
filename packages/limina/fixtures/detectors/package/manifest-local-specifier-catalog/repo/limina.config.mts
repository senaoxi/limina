export default {
  package: {
    entries: [
      {
        checks: ['boundary'],
        name: '@fixture/manifest-local-catalog',
        outDir: 'package-output',
      },
    ],
  },
  pipelines: {
    detector: ['package:check'],
  },
};
