export default {
  scope: {
    checkers: {
      tsc: {
        include: ['tsconfig.json', '**/tsconfig.json'],
      },
    },
  },
  source: {
    knip: {
      workspaces: {
        '@fixture/source-knip-config': [],
      },
    },
  },
  pipelines: {
    detector: ['source:check'],
  },
};
