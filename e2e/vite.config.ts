import { defineConfig } from 'vite-plus';

// The fakes' own tests (TMDB, Newznab, NNTP and their shared usenet/ module)
// the failure dump's and the host helpers'; the end-to-end scenarios run through run.ts.
export default defineConfig({
  test: { include: ['fakes/**/*.test.ts', 'dump.test.ts', 'host.test.ts'] },
});
