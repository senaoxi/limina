export default {
  config: {
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
