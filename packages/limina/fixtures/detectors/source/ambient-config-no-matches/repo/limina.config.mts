export default {
  scope: {
    checkers: {
      tsc: {
        include: ['tsconfig.json', '**/tsconfig.json'],
      },
    },
  },
  source: {
    declarations: {
      ambient: [
        {
          include: ['__typings__/missing/**/*.d.ts'],
          reason: 'The fixture intentionally targets a missing declaration.',
        },
      ],
    },
    knip: false,
  },
  pipelines: {
    detector: ['source:check'],
  },
};
