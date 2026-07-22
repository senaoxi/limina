export default {
  package: {
    entries: [
      {
        checks: ['boundary'],
        name: '@fixture/boundary-imports-target-escapes-root',
        outDir: 'package-output',
      },
    ],
  },
  pipelines: {
    detector: ['package:check'],
  },
};
