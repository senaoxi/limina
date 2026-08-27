export default {
  config: {
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
