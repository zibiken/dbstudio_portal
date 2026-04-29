import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    globalSetup: ['./tests/global-setup.js'],
    // Integration tests share a single Postgres database (portal_db). Files
    // racing in parallel can step on each other through shared tables —
    // most notably email_outbox, where worker.test.js's tickOnce can claim
    // rows enqueued by an admin/service test running concurrently. Run
    // files serially. Tests within a file remain ordered (vitest default).
    fileParallelism: false,
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
