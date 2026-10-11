export default {
  scope: {
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
