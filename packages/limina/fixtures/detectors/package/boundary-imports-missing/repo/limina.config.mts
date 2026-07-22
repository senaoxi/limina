export default {
  package: {
    entries: [
      {
        checks: ['boundary'],
        name: '@fixture/boundary-imports-missing',
        outDir: 'package-output',
      },
    ],
  },
  pipelines: {
    detector: ['package:check'],
  },
};
