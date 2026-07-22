export default {
  config: {
    checkers: {
      typescript: {
        include: ['tsconfig.json', '**/tsconfig.json'],
        preset: 'tsc',
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
