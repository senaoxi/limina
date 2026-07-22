export default {
  config: {
    checkers: {
      stable: {
        include: ['alpha/tsconfig.json'],
        preset: 'tsc',
      },
      native: {
        include: ['beta/tsconfig.json'],
        preset: 'tsgo',
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
