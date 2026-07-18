export default {
  config: {
    checkers: {
      typescript: {
        include: ['packages/library/tsconfig.json'],
        preset: 'tsc',
      },
    },
  },
};
