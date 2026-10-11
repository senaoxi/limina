export default {
  scope: {
    checkers: {
      tsc: {
        include: ['tsconfig.json', '**/tsconfig.json'],
      },
    },
  },
  pipelines: {
    detector: ['graph:check'],
  },
};
