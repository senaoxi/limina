export default {
  config: {
    checkers: {
      typescript: {
        include: ['tsconfig.json', '**/tsconfig.json'],
        preset: 'tsc',
      },
    },
  },
  pipelines: {
    detector: ['source:check'],
  },
  source: {
    knip: {
      workspaces: {
        '@fixture/source-knip-config': [],
      },
    },
  },
};
