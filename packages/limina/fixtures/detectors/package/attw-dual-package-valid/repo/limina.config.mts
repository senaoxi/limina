export default {
  package: {
    entries: [
      {
        attw: {
          profile: 'strict',
        },
        checks: ['attw'],
        name: '@fixture/attw-dual-package-valid',
        outDir: 'package-output',
      },
    ],
  },
  pipelines: {
    detector: ['package:check'],
  },
};
