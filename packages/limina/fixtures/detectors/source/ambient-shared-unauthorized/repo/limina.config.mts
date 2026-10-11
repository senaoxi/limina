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
          allowSharedAcrossOwners: false,
          allowTripleSlashReferences: true,
          include: ['__typings__/**/*.d.ts'],
          reason: 'Shared ambient declarations require explicit authorization.',
        },
      ],
    },
    knip: false,
  },
  pipelines: {
    detector: ['source:check'],
  },
};
