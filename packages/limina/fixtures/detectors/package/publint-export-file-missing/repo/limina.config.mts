export default {
  package: {
    entries: [
      {
        checks: ['publint'],
        name: '@fixture/publint-export-file-missing',
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
