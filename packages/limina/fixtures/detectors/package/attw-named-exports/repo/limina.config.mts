export default {
  package: {
    entries: [
      {
        attw: {
          profile: 'esm-only',
        },
        checks: ['attw'],
        name: '@fixture/attw-named-exports',
        outDir: 'package-output',
      },
    ],
  },
  pipelines: {
    detector: ['package:check'],
  },
};
