import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Each test file synthesizes whole CDK apps; the first aws-cdk-lib import alone takes a few seconds.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
