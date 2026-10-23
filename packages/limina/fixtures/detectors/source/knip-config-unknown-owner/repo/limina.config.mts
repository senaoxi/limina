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
        '@fixture/not-activated': {},
      },
    },
  },
  pipelines: {
    detector: ['source:check'],
  },
};
