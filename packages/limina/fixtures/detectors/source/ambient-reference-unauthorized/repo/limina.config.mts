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
          allowSharedAcrossOwners: true,
          allowTripleSlashReferences: false,
          include: ['__typings__/**/*.d.ts'],
          reason: 'The fixture isolates triple-slash reference authorization.',
        },
      ],
    },
    knip: false,
  },
};
