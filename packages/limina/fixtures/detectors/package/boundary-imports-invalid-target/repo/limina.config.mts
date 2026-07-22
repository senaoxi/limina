export default {
  package: {
    entries: [
      {
        checks: ['boundary'],
        name: '@fixture/boundary-imports-invalid-target',
        outDir: 'package-output',
      },
    ],
  },
  pipelines: {
    detector: ['package:check'],
  },
};
