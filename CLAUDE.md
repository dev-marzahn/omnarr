# Omnarr

A self-hosted media platform replacing Prowlarr, Sonarr and Radarr, on
Convex, Nuxt and Nuxt UI.

- `README.md`: what it is and how to install it.
- `ARCHITECTURE.md`: the components, the library data model and the
  pipeline, and where each lives in the tree.
- `CONTRIBUTING.md`: how to build, check and test, the contracts rule, the
  `pipelineRun` rules and the engineering rules.
- `CODING_STANDARDS.md`: what review checks.

Before every commit that changes code: `bun install`, then `bun run ready`
(build, `vp check`, every test). Run `bun run codegen` after any Convex
schema or function change and commit what it writes. A change to the
pipeline, the worker, the contracts or the compose files also runs the e2e
scenario it touches (`node e2e/run.ts <scenario>`).
