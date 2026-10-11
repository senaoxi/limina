export default {
  scope: {
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
