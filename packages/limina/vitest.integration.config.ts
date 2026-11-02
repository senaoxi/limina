import { defineConfig, type ViteUserConfig } from 'vitest/config';

const config: ViteUserConfig = defineConfig({
  test: {
    clearMocks: true,
    environment: 'node',
    globals: true,
    hookTimeout: 30_000,
    include: ['integration/tests/**/*.spec.ts'],
    // Each integration worker can also launch real compiler processes.
    maxWorkers: 2,
    restoreMocks: true,
    testTimeout: 120_000,
    watch: false,
  },
});

export default config;
