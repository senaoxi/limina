export default {
  config: {
    checkers: {
      typescript: {
        include: ['tsconfig.json'],
        preset: 'tsc',
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
