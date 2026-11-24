// merge-vpn-compose: the VPN layout in one file, for a front end that ignores COMPOSE_FILE.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vite-plus/test';

import { mergeCompose, parseCompose } from './check-ports.ts';
import { MERGED_FILE, mergeVpnCompose } from './merge-vpn-compose.ts';

const root = join(fileURLToPath(import.meta.url), '../..');
const read = (file: string) => readFileSync(join(root, file), 'utf8');

const BASE = `# The direct layout.
name: omnarr
services:
  qbittorrent:
    image: qbittorrent
    # The peer port.
    ports:
      - 6881:6881
    depends_on:
      setup: { condition: service_completed_successfully }
  worker:
    environment:
      QBITTORRENT_URL: http://qbittorrent:8080
      PUID: '1000'
`;
const VPN = `# The VPN layout.
services:
  gluetun:
    image: gluetun
    # For the tunnel.
    cap_add: [NET_ADMIN]
  qbittorrent:
    network_mode: service:gluetun
    networks: !reset null
    ports: !reset []
    depends_on:
      gluetun: { condition: service_started, restart: true }
  worker:
    environment:
      QBITTORRENT_URL: http://gluetun:8080
`;

describe('mergeVpnCompose', () => {
  test("merges mappings by key, replaces scalars, drops `!reset` keys, keeps comments and swaps the base's header", () => {
    const out = mergeVpnCompose(BASE, VPN);
    expect(out).toContain('# omnarr, the VPN layout in one file');
    expect(out).not.toContain('# The direct layout.');
    expect(out).toContain('  gluetun:\n    image: gluetun\n    # For the tunnel.\n    cap_add: [NET_ADMIN]\n');
    expect(out).not.toContain('ports');
    expect(out).not.toContain('!reset');
    expect(parseCompose(out)).toEqual({
      name: 'omnarr',
      services: {
        qbittorrent: {
          image: 'qbittorrent',
          network_mode: 'service:gluetun',
          depends_on: { setup: { condition: 'service_completed_successfully' }, gluetun: { condition: 'service_started', restart: true } },
        },
        worker: { environment: { QBITTORRENT_URL: 'http://gluetun:8080', PUID: '1000' } },
        gluetun: { image: 'gluetun', cap_add: ['NET_ADMIN'] },
      },
    });
  });

  test('fails on a sequence in both files, which Compose may merge by key', () => {
    expect(() => mergeVpnCompose(BASE, 'services:\n  qbittorrent:\n    ports: ["6882:6882"]\n')).toThrow(
      'services.qbittorrent.ports: a sequence in both files',
    );
  });
});

describe(MERGED_FILE, () => {
  test('is up to date: run `node scripts/merge-vpn-compose.ts` after changing compose.yml or compose.vpn.yml', () => {
    expect(read(MERGED_FILE)).toBe(mergeVpnCompose(read('compose.yml'), read('compose.vpn.yml')));
  });

  test('is what the two files merge to', () => {
    expect(parseCompose(read(MERGED_FILE))).toEqual(mergeCompose([parseCompose(read('compose.yml')), parseCompose(read('compose.vpn.yml'))]));
  });

  // Compose's own merge, where Docker is installed (CI, a dev machine with the e2e).
  const docker = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;
  test.skipIf(!docker)('is what `docker compose -f compose.yml -f compose.vpn.yml config` resolves to', () => {
    const config = (...files: string[]) => {
      const result = spawnSync(
        'docker',
        ['compose', '--project-directory', root, ...files.flatMap((f) => ['-f', join(root, f)]), 'config', '--no-interpolate', '--format', 'json'],
        {
          encoding: 'utf8',
          env: { ...process.env, COMPOSE_FILE: '', COMPOSE_PROFILES: '' },
        },
      );
      expect(result.stderr).toBe('');
      const project = JSON.parse(result.stdout) as { services: Record<string, { environment?: Record<string, string> | string[] }> };
      // Without interpolation, Compose prints a merged environment as a list, a single file's as a mapping.
      for (const service of Object.values(project.services))
        if (Array.isArray(service.environment)) service.environment = Object.fromEntries(service.environment.map((entry) => entry.split(/=(.*)/s, 2)));
      return project;
    };
    expect(config(MERGED_FILE)).toEqual(config('compose.yml', 'compose.vpn.yml'));
  });
});
