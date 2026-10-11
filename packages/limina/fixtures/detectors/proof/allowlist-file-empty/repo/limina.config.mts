export default {
  scope: {
    checkers: {
      tsc: {
        include: ['tsconfig.json', '**/tsconfig.json'],
      },
    },
    source: {
      include: ['packages/**/*.ts'],
    },
  },
  proof: {
    allowlist: [
      {
        file: '',
        reason: 'empty paths must never silently bypass proof coverage',
      },
    ],
  },
  pipelines: {
    detector: ['proof:check'],
  },
};
