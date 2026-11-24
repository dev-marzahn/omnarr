import { defineConfig } from 'vite-plus';

// Generated code keeps the style of whatever generates it. docs/ holds research
// spikes with their own toolchains.
const generated = ['**/_generated/**', '**/_generated.ts', '**/betterAuth/schema.ts', '**/.nuxt/**', '**/.output/**', 'docs/**', 'compose.vpn.merged.yml'];

export default defineConfig({
  fmt: {
    printWidth: 160,
    singleQuote: true,
    semi: true,
    trailingComma: 'all',
    sortImports: true,
    ignorePatterns: generated,
  },
  lint: {
    ignorePatterns: generated,
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: {
      'vite-plus/prefer-vite-plus-imports': 'error',
      'typescript/explicit-member-accessibility': ['error', { accessibility: 'explicit' }],
    },
    options: { typeAware: true, typeCheck: true },
  },
  // No run cache: a cache hit on `build` doesn't restore dist/ or .nuxt/, which
  // the worker image and the web typecheck read.
});
