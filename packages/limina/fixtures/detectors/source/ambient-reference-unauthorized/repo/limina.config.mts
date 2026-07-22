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
