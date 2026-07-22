export default {
  config: {
    checkers: {
      typescript: {
        include: ['tsconfig.json', '**/tsconfig.json'],
        preset: 'tsc',
      },
    },
  },
  pipelines: {
    detector: ['source:check'],
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
};
