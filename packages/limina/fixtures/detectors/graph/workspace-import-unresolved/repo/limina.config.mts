export default {
  config: {
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
