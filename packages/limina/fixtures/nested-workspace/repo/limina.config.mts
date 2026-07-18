export default {
  config: {
    checkers: {
      typescript: {
        include: ['packages/**/tsconfig.json'],
        preset: 'tsc',
      },
    },
  },
};
