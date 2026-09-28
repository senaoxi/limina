export default {
  config: {
    checkers: {
      tsc: {
        include: ['tsconfig.json', '**/tsconfig.json'],
      },
    },
    source: {
      include: ['packages/**/*.ts'],
    },
  },
  pipelines: {
    detector: ['proof:check'],
  },
  proof: {
    allowlist: [
      {
        file: '',
        reason: 'empty paths must never silently bypass proof coverage',
      },
    ],
  },
};
