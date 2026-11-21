import { defineConfig } from 'vite-plus';

export default defineConfig({
  // The backend image's hook script and reset command: standalone Node scripts, so the image needs no node_modules.
  pack: {
    entry: { hooks: 'image/hooks.ts', reset: 'image/reset.ts' },
    platform: 'node',
    format: 'esm',
    dts: false,
    outDir: 'dist/image',
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'convex',
          environment: 'edge-runtime',
          // These ship test helpers that use import.meta.glob.
          server: {
            deps: {
              inline: ['convex-test', '@convex-dev/workflow', '@convex-dev/workpool', '@convex-dev/batch-worker', '@dev-marzahn/convex-workflow-migrations'],
            },
          },
          include: ['test/**/*.test.ts'],
          exclude: ['test/image/**'],
        },
      },
      // The image's scripts run on Node.
      { extends: true, test: { name: 'image', environment: 'node', include: ['test/image/**/*.test.ts'] } },
    ],
  },
});
