export default {
  config: {
    checkers: {
      tsc: {
        include: ['tsconfig.json', '**/tsconfig.json'],
      },
    },
  },
  graph: {
    rules: {
      runtime: {
        allow: {
          refs: [
            {
              path: 'packages/app/tsconfig.node.json',
              reason: 'allowed only when the edge is not explicitly denied',
            },
          ],
        },
        deny: {
          refs: [
            {
              path: 'packages/app/tsconfig.node.json',
              reason: 'runtime code must not depend on the node-only project',
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
