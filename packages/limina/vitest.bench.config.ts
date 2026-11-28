import codspeedPlugin from '@codspeed/vitest-plugin';
import { defineConfig, type ViteUserConfig } from 'vitest/config';

const config: ViteUserConfig = defineConfig({
  plugins: [codspeedPlugin()],
  test: {
    environment: 'node',
    include: ['bench/**/*.bench.ts'],
    benchmark: {
      include: ['bench/**/*.bench.ts'],
    },
    // Graph benchmarks build TypeScript programs; simulation slows them down.
    hookTimeout: 600_000,
    testTimeout: 600_000,
    watch: false,
  },
});

export default config;
