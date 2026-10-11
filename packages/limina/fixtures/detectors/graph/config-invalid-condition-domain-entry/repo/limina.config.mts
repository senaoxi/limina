export default {
  scope: {},
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
