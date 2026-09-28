export default {
  package: {
    entries: [
      {
        attw: { profile: 'node16' },
        checks: ['attw'],
        name: '@fixture/attw-cjs-resolves-to-esm',
        outDir: 'package-output',
      },
    ],
  },
  pipelines: { detector: ['package:check'] },
};
