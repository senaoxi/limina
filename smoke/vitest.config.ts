import { defineConfig, type ViteUserConfig } from 'vitest/config';

const config: ViteUserConfig = defineConfig({
  test: {
    environment: 'node',
    include: ['*.spec.ts'],
    // Packed consumers start independent package managers and semantic checkers.
    maxWorkers: 2,
    testTimeout: 300_000,
    clearMocks: true,
    restoreMocks: true,
    watch: false,
  },
});

export default config;
