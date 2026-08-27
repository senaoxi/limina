export default {
  config: {
    checkers: {
      tsc: {
        include: ['tsconfig.json', '**/tsconfig.json'],
      },
    },
  },
  graph: {
    conditionDomains: [
      {
        customConditions: ['node', 'source'],
        entry: 'packages/app/tsconfig.web.json',
        name: 'web',
      },
    ],
  },
  pipelines: {
    detector: ['graph:check'],
  },
};
