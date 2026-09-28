export default {
  package: {
    entries: [
      {
        checks: ['boundary'],
        name: '@fixture/manifest-local-file',
        outDir: 'package-output',
      },
    ],
  },
  pipelines: {
    detector: ['package:check'],
  },
};
