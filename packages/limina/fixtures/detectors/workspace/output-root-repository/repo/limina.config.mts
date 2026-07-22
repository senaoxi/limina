export default {
  config: {},
  package: {
    entries: [
      {
        checks: [],
        name: '@fixture/workspace-output-root-repository',
        outDir: '.',
      },
    ],
  },
  pipelines: {
    detector: ['graph:check'],
  },
};
