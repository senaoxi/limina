export default {
  scope: {},
  graph: {
    rules: {
      ' ': { deny: { refs: [] } },
    },
  },
  pipelines: {
    detector: ['graph:check'],
  },
};
