export default {
  package: {
    entries: [
      {
        attw: {
          profile: 'esm-only',
        },
        checks: ['attw'],
        name: '@fixture/attw-unexpected-module-syntax',
        outDir: 'package-output',
      },
    ],
  },
  pipelines: {
    detector: ['package:check'],
  },
};
