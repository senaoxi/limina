export default {
  scope: {
    checkers: {
      tsc: {
        include: ['tsconfig.json', '**/tsconfig.json'],
      },
    },
  },
  source: {
    knip: false,
  },
  pipelines: {
    detector: ['source:check'],
  },
};
