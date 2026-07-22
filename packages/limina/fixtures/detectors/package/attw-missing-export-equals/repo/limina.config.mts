export default {
  package: {
    entries: [
      {
        attw: { profile: 'esm-only' },
        checks: ['attw'],
        name: '@fixture/attw-missing-export-equals',
        outDir: 'package-output',
      },
    ],
  },
  pipelines: { detector: ['package:check'] },
};
