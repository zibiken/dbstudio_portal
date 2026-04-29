import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    globalSetup: ['./tests/global-setup.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['lib/**', 'domain/**', 'config/**'],
      thresholds: {
        'lib/crypto/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'lib/auth/**':   { lines: 80, functions: 80, branches: 80, statements: 80 },
        'domain/credentials/**': { lines: 80, functions: 80, branches: 80, statements: 80 }
      }
    }
  }
});
