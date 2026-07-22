export default {
  config: {
    checkers: {
      typescript: {
        include: ['packages/pkg/tsconfig.json'],
        preset: 'tsc',
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
