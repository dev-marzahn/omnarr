import { defineConfig } from 'vite-plus';

// Lint and format settings live in the repo root's vite.config.ts.
export default defineConfig({
  pack: {
    // One standalone file, so the image needs no node_modules.
    entry: { main: 'src/main.ts' },
    platform: 'node',
    format: 'esm',
    dts: false,
    deps: { alwaysBundle: [/./], onlyBundle: false },
  },
});
