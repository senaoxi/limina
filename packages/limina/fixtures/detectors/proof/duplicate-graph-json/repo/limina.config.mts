export default {
  scope: {
    checkers: {
      tsc: {
        include: ['packages/pkg/tsconfig.json'],
      },
    },
    source: {
      include: ['packages/**/src/**/*.json'],
    },
  },
  pipelines: {
    detector: ['proof:check'],
  },
};
