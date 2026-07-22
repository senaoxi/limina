export default {
  config: {
    checkers: {
      typescript: {
        include: ['tsconfig.json', '**/tsconfig.json'],
        preset: 'tsc',
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
