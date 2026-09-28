export default {
  package: {
    entries: [
      {
        checks: ['boundary'],
        name: '@fixture/manifest-name-missing',
        outDir: 'package-output',
      },
    ],
  },
  pipelines: {
    detector: ['package:check'],
  },
};
