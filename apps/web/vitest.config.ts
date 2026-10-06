import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'jsdom',
    coverage: { provider: 'v8', include: ['src/lib/**/*.ts'], exclude: ['src/lib/icons.ts'] },
  },
});
