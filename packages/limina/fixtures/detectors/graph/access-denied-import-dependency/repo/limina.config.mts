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
    rules: {
      runtime: {
        deny: {
          deps: [
            {
              name: 'node:*',
              reason:
                'browser-facing runtime code must not import Node builtins',
            },
          ],
        },
      },
    },
  },
  pipelines: {
    detector: ['graph:check'],
  },
};
