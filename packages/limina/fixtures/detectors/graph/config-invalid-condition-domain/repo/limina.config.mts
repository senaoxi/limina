export default {
  config: {},
  graph: {
    conditionDomains: [
      {
        customConditions: [],
        entry: 'tsconfig.json',
        name: '',
      },
    ],
  },
  pipelines: {
    detector: ['graph:check'],
  },
};
