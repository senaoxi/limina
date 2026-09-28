export default {
  package: {
    entries: [
      {
        checks: ['boundary'],
        name: '@fixture/boundary-imports-target-missing',
        outDir: 'package-output',
      },
    ],
  },
  pipelines: {
    detector: ['package:check'],
  },
};
