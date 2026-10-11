export default {
  scope: {
    checkers: {
      tsc: {
        include: ['packages/*/tsconfig.json', '../external/*/tsconfig.json'],
      },
    },
  },
};
