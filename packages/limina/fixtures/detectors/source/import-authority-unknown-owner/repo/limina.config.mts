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
