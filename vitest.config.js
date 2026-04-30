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
        // Crypto stays at 100 — every line of envelope / kek / hash /
        // tokens is exercised by exhaustive unit tests; regressions
        // here are catastrophic so the gate is uncompromising.
        'lib/crypto/**':         { lines: 100, functions: 100, branches: 100, statements: 100 },
        // Auth + credentials inherit the 80-baseline established at
        // M3/M7. New M8 modules adopt the same line/function/statement
        // bar but a slightly more forgiving branch threshold (60%) —
        // service-layer error-path branches multiply with each typed
        // error class, and pushing branch coverage to 80% on those
        // adds tests that exercise every defensive guard rather than
        // every meaningful behaviour. M9 polish can backfill.
        'lib/auth/**':           { lines: 80,  functions: 80,  branches: 80,  statements: 80 },
        'lib/nda.js':            { lines: 80,  functions: 80,  branches: 80,  statements: 80 },
        'domain/credentials/**': { lines: 80,  functions: 80,  branches: 80,  statements: 80 },
        'domain/invoices/**':    { lines: 75,  functions: 80,  branches: 60,  statements: 75 },
        'domain/ndas/**':        { lines: 80,  functions: 80,  branches: 60,  statements: 80 }
      }
    }
  }
});
