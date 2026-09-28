export default {
  config: {
    checkers: {
      tsc: {
        include: ['alpha/tsconfig.json', 'beta/tsconfig.json'],
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
