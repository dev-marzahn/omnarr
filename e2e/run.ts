// Runs the end-to-end scenarios: each scenario's test file
// brings up what it needs in Docker and tears it down. With no argument,
// every scenario runs.
//
//   bun run e2e                 every scenario
//   node e2e/run.ts upgrade     one scenario
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROJECT, releaseSlot, slotCount, takeSlot } from './host.ts';
import { buildImages, BUILT_MARKER } from './image.ts';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Scenario → test file. `pipeline` is search, download, import, preparation
 * and publish over Usenet, with its failures; `jellyfin` is the Jellyfin
 * setup, setup outage and password push; `playback` is a direct play;
 * `torrents` is torrents in the direct layout; `vpn` is torrents with
 * gluetun and a test WireGuard server (it needs /dev/net/tun and NET_ADMIN
 * on the Docker host); `scan` is the library scan; `install` is install and
 * first run on the shipped compose files; `stackUpgrade` is an upgrade and a
 * downgrade, from an older commit built here (or E2E_FROM_VERSION's GitHub
 * release) to this build; `nyaa` is Nyaa against the fake Nyaa; `sites` is
 * site definitions against the fake definitions server and Star Site.
 */
const SCENARIOS: Record<string, string> = {
  install: 'install.e2e.ts',
  pipeline: 'pipeline.e2e.ts',
  jellyfin: 'jellyfin.e2e.ts',
  torrents: 'torrents.e2e.ts',
  vpn: 'vpn.e2e.ts',
  upgrade: 'upgrade.e2e.ts',
  playback: 'playback.e2e.ts',
  scan: 'scan.e2e.ts',
  stackUpgrade: 'stackUpgrade.e2e.ts',
  nyaa: 'nyaa.e2e.ts',
  sites: 'sites.e2e.ts',
};

const asked = process.argv.slice(2);
const unknown = asked.filter((name) => !(name in SCENARIOS));
if (unknown.length > 0) {
  console.error(`Unknown scenario: ${unknown.join(', ')}. Known: ${Object.keys(SCENARIOS).join(', ')}.`);
  process.exit(2);
}

// One build of the three images for every scenario of this run (image.ts).
const built = buildImages();
console.log(`e2e: images ${BUILT_MARKER} (${built.toFixed(1)} s)`);
// One of the host's E2E_SLOTS before any stack (host.ts): more stacks at once than the Docker VM holds starve
// each other into timeouts. A kept stack (E2E_KEEP=1) holds it until its down().
console.log(`e2e: project ${PROJECT}, slot ${await takeSlot(PROJECT, slotCount())} of ${slotCount()}`);
// E2E_SLOT_HELD: the scenarios' down() leaves the slot to this run.
const env = { ...process.env, E2E_IMAGES_BUILT: BUILT_MARKER, E2E_SLOT_HELD: '1' };

let failed = false;
const times: string[] = [];
for (const name of asked.length > 0 ? asked : Object.keys(SCENARIOS)) {
  console.log(`e2e: ${name}`);
  const started = Date.now();
  // The scenario's one file is the config's include (E2E_FILE), not a filter, which would match by substring.
  // Verbose: each test's time, for finding the next slow test.
  const result = spawnSync(join(here, 'node_modules/.bin/vp'), ['test', '--config', 'vite.e2e.config.ts', '--reporter=verbose'], {
    cwd: here,
    stdio: 'inherit',
    // E2E_SCENARIO names the failure dump's folder, e2e/artifacts/<scenario> (stack.ts).
    env: { ...env, E2E_SCENARIO: name, E2E_FILE: SCENARIOS[name]! },
  });
  if (result.status !== 0) failed = true;
  times.push(`${name} ${((Date.now() - started) / 1000).toFixed(0)} s${result.status === 0 ? '' : ' (failed)'}`);
}
console.log(`e2e: ${times.join(', ')}`);
if (process.env.E2E_KEEP !== '1') releaseSlot(PROJECT);
process.exit(failed ? 1 : 0);
