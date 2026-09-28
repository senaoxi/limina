export default {
  package: {
    entries: [
      {
        checks: ['boundary'],
        name: '@fixture/boundary-imports-target-unsupported',
        outDir: 'package-output',
      },
    ],
  },
  pipelines: {
    detector: ['package:check'],
  },
};
