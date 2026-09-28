export default {
  config: {
    checkers: {
      tsc: {
        include: ['tsconfig.json'],
      },
    },
    source: {
      include: ['packages/**/*.ts'],
    },
  },
  pipelines: {
    detector: ['proof:check'],
  },
};
