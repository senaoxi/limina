export default {
  package: {
    entries: [
      {
        checks: ['publint'],
        name: '@fixture/publint-module-should-be-esm',
        outDir: 'package-output',
        publint: {
          level: 'error',
          strict: true,
        },
      },
    ],
  },
  pipelines: {
    detector: ['package:check'],
  },
};
