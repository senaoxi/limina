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
          allowSharedAcrossOwners: true,
          allowTripleSlashReferences: false,
          include: ['__typings__/**/*.d.ts'],
          reason: 'The fixture isolates triple-slash reference authorization.',
        },
      ],
    },
    knip: false,
  },
  pipelines: {
    detector: ['source:check'],
  },
};
