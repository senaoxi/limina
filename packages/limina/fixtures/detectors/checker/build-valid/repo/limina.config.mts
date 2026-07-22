export default {
  config: {
    checkers: {
      typescript: {
        include: ['packages/app/tsconfig.json'],
        preset: 'tsc',
      },
    },
  },
  pipelines: {
    detector: ['checker:build'],
  },
};
