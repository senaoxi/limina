export default {
  config: {
    checkers: {
      typescript: {
        include: ['tsconfig.json', '**/tsconfig.json'],
        preset: 'tsc',
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
