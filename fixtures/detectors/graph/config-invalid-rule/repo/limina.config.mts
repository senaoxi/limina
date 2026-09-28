export default {
  config: {},
  graph: {
    rules: {
      runtime: {
        experimental: true,
      },
    },
  },
  pipelines: {
    detector: ['graph:check'],
  },
};
