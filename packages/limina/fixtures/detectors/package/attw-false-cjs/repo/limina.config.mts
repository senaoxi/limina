export default {
  package: {
    entries: [
      {
        attw: {
          profile: 'esm-only',
        },
        checks: ['attw'],
        name: '@fixture/attw-false-cjs',
        outDir: 'package-output',
      },
    ],
  },
  pipelines: {
    detector: ['package:check'],
  },
};
