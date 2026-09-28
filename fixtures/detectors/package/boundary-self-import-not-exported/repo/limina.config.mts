export default {
  package: {
    entries: [
      {
        checks: ['boundary'],
        name: '@fixture/boundary-self-import',
        outDir: 'package-output',
      },
    ],
  },
  pipelines: {
    detector: ['package:check'],
  },
};
