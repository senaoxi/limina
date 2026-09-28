export default {
  package: {
    entries: [
      {
        checks: ['boundary'],
        name: '@fixture/boundary-external-package-undeclared',
        outDir: 'package-output',
      },
    ],
  },
  pipelines: {
    detector: ['package:check'],
  },
};
