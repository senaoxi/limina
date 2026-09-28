export default {
  config: {
    checkers: {
      'vue-tsc': {
        include: ['tsconfig.json'],
      },
    },
    source: {
      include: ['src/**/*.{ts,vue}'],
    },
  },
};
