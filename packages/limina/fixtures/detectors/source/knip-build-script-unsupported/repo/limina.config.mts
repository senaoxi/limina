export default {
  scope: {
    checkers: {
      tsc: {
        include: ['tsconfig.json', '**/tsconfig.json'],
      },
    },
  },
  source: {
    knip: true,
  },
  pipelines: {
    detector: ['source:check'],
  },
};
