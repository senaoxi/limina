export default {
  config: {},
  graph: {
    conditionDomains: [
      {
        customConditions: [],
        entry: 'configs/missing.json',
        name: 'missing-entry',
      },
    ],
  },
  pipelines: {
    detector: ['graph:check'],
  },
};
