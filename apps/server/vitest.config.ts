import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 120_000, // first run may start the Postgres container
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'], // the process entry point, exercised by scripts/smoke.sh
      // below these numbers `pnpm test:coverage` fails. Raise them as coverage grows; never lower them to make a build pass.
      thresholds: {
        lines: 95, statements: 93, functions: 93, branches: 88,
        'src/services/**': { lines: 95, branches: 88 },
        'src/crypto.ts': { lines: 95, branches: 90 },
        'src/rewind.ts': { lines: 100 },
      },
    },
  },
});
