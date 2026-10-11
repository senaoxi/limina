export default {
  scope: {
    checkers: {
      tsc: {
        include: ['tsconfig.json', '**/tsconfig.json'],
      },
    },
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
  pipelines: {
    detector: ['source:check'],
  },
};
