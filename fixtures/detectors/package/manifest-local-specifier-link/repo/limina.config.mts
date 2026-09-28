export default {
  package: {
    entries: [
      {
        checks: ['boundary'],
        name: '@fixture/manifest-local-link',
        outDir: 'package-output',
      },
    ],
  },
  pipelines: {
    detector: ['package:check'],
  },
};
