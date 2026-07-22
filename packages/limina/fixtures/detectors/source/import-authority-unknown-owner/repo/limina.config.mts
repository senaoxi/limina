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
    importAuthority: {
      allow: {
        '@fixture/source-import-authority-missing': [
          {
            reason: 'The unknown owner is the only invalid input.',
            workspaceRootDependencies: ['zod'],
          },
        ],
      },
    },
    knip: false,
  },
};
