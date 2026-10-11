export default {
  scope: {},
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
