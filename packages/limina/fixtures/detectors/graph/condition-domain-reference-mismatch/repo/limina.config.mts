export default {
  config: {
    checkers: {
      typescript: {
        include: ['tsconfig.json', '**/tsconfig.json'],
        preset: 'tsc',
      },
    },
  },
  pipelines: {
    detector: ['graph:check'],
  },
};
