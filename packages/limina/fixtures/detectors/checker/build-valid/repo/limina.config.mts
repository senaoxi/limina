export default {
  scope: {
    checkers: {
      tsc: {
        include: ['packages/app/tsconfig.json'],
      },
    },
  },
  pipelines: {
    detector: ['checker:build'],
  },
};
