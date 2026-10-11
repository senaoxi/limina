export default {
  scope: {
    checkers: {
      tsc: {
        include: ['tsconfig.json', '**/tsconfig.json'],
      },
    },
  },
  source: {
    knip: { workspaces: {} },
  },
  pipelines: {
    detector: ['source:check'],
  },
};
