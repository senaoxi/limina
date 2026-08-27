export default {
  config: {
    checkers: {
      tsc: {
        include: ['tsconfig.json', '**/tsconfig.json'],
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
