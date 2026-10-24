import { defineConfig, type ViteUserConfig } from 'vitest/config';

const config: ViteUserConfig = defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/__tests__/**/*.spec.ts'],
    // Admission and ESLint suites each start substantial parser services.
    maxWorkers: 2,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    clearMocks: true,
    restoreMocks: true,
    watch: false,
  },
});

export default config;
