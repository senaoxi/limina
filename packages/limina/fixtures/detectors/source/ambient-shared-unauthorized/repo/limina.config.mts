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
          allowSharedAcrossOwners: false,
          allowTripleSlashReferences: true,
          include: ['__typings__/**/*.d.ts'],
          reason: 'Shared ambient declarations require explicit authorization.',
        },
      ],
    },
    knip: false,
  },
};
