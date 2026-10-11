export default {
  scope: {},
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
