export default {
  package: {
    entries: [
      {
        attw: { profile: 'esm-only' },
        checks: ['attw'],
        name: '@fixture/attw-fallback-condition',
        outDir: 'package-output',
      },
    ],
  },
  pipelines: { detector: ['package:check'] },
};
