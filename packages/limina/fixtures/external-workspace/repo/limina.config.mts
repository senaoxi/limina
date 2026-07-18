export default {
  config: {
    checkers: {
      typescript: {
        include: ['packages/*/tsconfig.json', '../external/*/tsconfig.json'],
        preset: 'tsc',
      },
    },
  },
};
