export default {
  package: {
    entries: [
      {
        attw: { profile: 'esm-only' },
        checks: ['attw'],
        name: '@fixture/attw-no-resolution-bundler',
        outDir: 'package-output',
      },
    ],
  },
  pipelines: { detector: ['package:check'] },
};
