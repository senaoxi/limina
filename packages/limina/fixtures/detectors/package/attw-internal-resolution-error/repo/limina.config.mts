export default {
  package: {
    entries: [
      {
        attw: { profile: 'esm-only' },
        checks: ['attw'],
        name: '@fixture/attw-internal-resolution-error',
        outDir: 'package-output',
      },
    ],
  },
  pipelines: { detector: ['package:check'] },
};
