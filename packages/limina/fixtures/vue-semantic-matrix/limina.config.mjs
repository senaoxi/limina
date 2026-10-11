export default {
  scope: {
    checkers: {
      'vue-tsc': {
        include: ['cases/*/tsconfig.json'],
      },
    },
    source: {
      include: ['cases/**/*.{ts,vue}'],
    },
  },
};
