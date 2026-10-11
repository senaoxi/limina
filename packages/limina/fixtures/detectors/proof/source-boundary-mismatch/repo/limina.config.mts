export default {
  scope: {
    checkers: {
      tsc: {
        include: ['tsconfig.json', '**/tsconfig.json'],
      },
    },
    source: {
      include: ['packages/pkg/src/**/*.ts'],
    },
  },
  pipelines: {
    detector: ['proof:check'],
  },
};
