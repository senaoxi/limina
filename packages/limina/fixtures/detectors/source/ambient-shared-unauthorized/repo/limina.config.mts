export default {
  config: {
    checkers: {
      tsc: {
        include: ['tsconfig.json', '**/tsconfig.json'],
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
