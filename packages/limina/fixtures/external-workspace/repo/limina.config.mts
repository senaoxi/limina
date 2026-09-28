export default {
  config: {
    checkers: {
      tsc: {
        include: ['packages/*/tsconfig.json', '../external/*/tsconfig.json'],
      },
    },
  },
};
