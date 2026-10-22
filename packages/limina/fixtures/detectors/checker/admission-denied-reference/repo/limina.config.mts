export default {
  scope: { checkers: { tsc: { include: ['tsconfig.json'] } } },
  graph: {
    rules: {
      consumer: {
        deny: {
          refs: [{ path: 'tsconfig.b.json', reason: 'Private provider' }],
        },
      },
    },
  },
  pipelines: { detector: ['checker:build'] },
};
