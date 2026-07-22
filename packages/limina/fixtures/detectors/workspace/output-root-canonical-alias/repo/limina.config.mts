export default {
  config: {},
  package: {
    entries: [
      {
        checks: [],
        name: '@fixture/workspace-output-root-canonical-alias',
        outDir: 'alias',
      },
    ],
  },
  pipelines: {
    detector: ['graph:check'],
  },
};
