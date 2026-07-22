export default {
  package: {
    entries: [
      {
        checks: ['publint'],
        name: '@fixture/publint-exports-types-order',
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
