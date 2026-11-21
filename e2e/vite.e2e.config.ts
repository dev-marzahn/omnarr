import { defineConfig } from 'vite-plus';

// The end-to-end scenarios, run by run.ts, one file at a
// time: each brings up its own stack in Docker.
export default defineConfig({
  test: {
    // run.ts names its scenario's file (E2E_FILE): a file filter is a substring, and upgrade.e2e.ts is one of stackUpgrade.e2e.ts.
    include: [process.env.E2E_FILE || '*.e2e.ts'],
    // A failed test leaves a failure dump in e2e/artifacts/<scenario> (dump.ts).
    setupFiles: ['./failures.ts'],
    fileParallelism: false,
    // About twice the slowest passing time, so a failure ends in minutes: the slowest test without its own
    // timeout is vpn's WireGuard outage (238 s on CI); the slowest hook is a stack's down() with its failure
    // dump. A scenario's beforeAll (up(), up to 175 s on CI) and slow tests set their own.
    testTimeout: 480_000,
    hookTimeout: 120_000,
  },
});
