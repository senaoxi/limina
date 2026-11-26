export default {
  scope: {
    checkers: {
      tsc: {
        include: ['tsconfig.json', '**/tsconfig.json'],
      },
    },
  },
  source: { forbidCrossPackageRelativeImports: true, knip: false },
  pipelines: {
    detector: ['source:check'],
  },
};
