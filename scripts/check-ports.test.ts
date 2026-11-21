import { describe, expect, test } from 'vite-plus/test';

import { composeLayouts, mergeCompose, parseCompose, publishedWebUiPorts, shippedViolations } from './check-ports.ts';

const check = (compose: string) => publishedWebUiPorts(parseCompose(compose), 'compose.yaml').map((v) => `${v.service}: ${v.reason}`);
const checkVpn = (base: string, override: string) =>
  publishedWebUiPorts(mergeCompose([parseCompose(base), parseCompose(override)]), 'compose.vpn.yml', 'vpn').map((v) => `${v.service}: ${v.reason}`);

// The direct layout, the base file.
const BASE = `
services:
  qbittorrent:
    image: qbittorrentofficial/qbittorrent-nox:5.3.0-2
    networks: [internal]
    environment: { QBT_WEBUI_PORT: '8080', QBT_TORRENTING_PORT: '6881' }
    ports: ['\${OMNARR_PEER_PORT:-6881}:6881', '\${OMNARR_PEER_PORT:-6881}:6881/udp']
`;

describe('publishedWebUiPorts', () => {
  test('passes clients whose WebUI stays on the internal network', () => {
    expect(
      check(`
services:
  nzbget:
    image: nzbgetcom/nzbget:v25.4
  qbittorrent:
    image: lscr.io/linuxserver/qbittorrent:5.1.2
    ports: ['6881:6881', '6881:6881/udp']
  backend:
    image: ghcr.io/example/backend
    ports: ['3210:3210']
  jellyfin:
    image: jellyfin/jellyfin:10.11.0
    ports: ['8096:8096']
`),
    ).toEqual([]);
  });

  test.each([
    ['short syntax', `ports: ['6789:6789']`],
    ['a host address', `ports: ['127.0.0.1:16789:6789']`],
    ['a protocol', `ports: ['6789:6789/tcp']`],
    ['only the container port', `ports: ['6789']`],
    ['a range', `ports: ['6780-6790:6780-6790']`],
    ['long syntax', `ports: [{ target: 6789, published: 8000 }]`],
  ])('fails NZBGet’s WebUI published with %s', (_name, ports) => {
    expect(check(`services:\n  nzbget:\n    image: nzbgetcom/nzbget\n    ${ports}\n`)).toEqual(['nzbget: publishes the NZBGet WebUI port 6789']);
  });

  test('fails NZBGet publishing any port', () => {
    expect(check(`services:\n  nzbget:\n    image: nzbgetcom/nzbget\n    ports: ['119:119']\n`)).toEqual([
      'nzbget: publishes port 119; NZBGet publishes no port',
    ]);
  });

  test('fails gluetun publishing any port', () => {
    expect(check(`services:\n  vpn:\n    image: qmcgaw/gluetun:v3.41.3\n    ports: ['8000:8000', '8080:8080']\n`)).toEqual([
      'vpn: publishes port 8000; gluetun publishes no port',
      'vpn: publishes port 8080; gluetun publishes no port',
    ]);
  });

  test('fails qBittorrent’s WebUI, also on a port set through QBT_WEBUI_PORT', () => {
    expect(check(`services:\n  qb:\n    image: qbittorrentofficial/qbittorrent-nox\n    ports: ['8080:8080']\n`)).toEqual([
      'qb: publishes the qBittorrent WebUI port 8080',
    ]);
    expect(
      check(`services:\n  qb:\n    image: qbittorrentofficial/qbittorrent-nox\n    environment: { QBT_WEBUI_PORT: '9090' }\n    ports: ['9090:9090']\n`),
    ).toEqual(['qb: publishes the qBittorrent WebUI port 9090']);
    expect(
      check(`services:\n  qb:\n    image: qbittorrentofficial/qbittorrent-nox\n    environment: ['QBT_WEBUI_PORT=9090']\n    ports: ['9090:9090']\n`),
    ).toEqual(['qb: publishes the qBittorrent WebUI port 9090']);
  });

  test('fails qBittorrent publishing any port but its peer port', () => {
    expect(
      check(`services:\n  qb:\n    image: qbittorrentofficial/qbittorrent-nox\n    ports: ['6881:6881', '9000:9000', '6881-6882:6881-6882/udp']\n`),
    ).toEqual([
      'qb: publishes port 9000; qBittorrent publishes only its peer port 6881',
      'qb: publishes port 6881-6882; qBittorrent publishes only its peer port 6881',
    ]);
  });

  test('reads qBittorrent’s peer port from QBT_TORRENTING_PORT', () => {
    expect(
      check(
        `services:\n  qb:\n    image: qbittorrentofficial/qbittorrent-nox\n    environment: { QBT_TORRENTING_PORT: '50000' }\n    ports: ['50000:50000', '50000:50000/udp', '6881:6881']\n`,
      ),
    ).toEqual(['qb: publishes port 6881; qBittorrent publishes only its peer port 50000']);
  });

  test('resolves ${VAR:-default} to its default', () => {
    expect(
      check(`
services:
  qb:
    image: qbittorrentofficial/qbittorrent-nox
    environment:
      QBT_WEBUI_PORT: \${QBT_WEBUI_PORT:-9090}
      QBT_TORRENTING_PORT: \${QBT_TORRENTING_PORT:-50000}
    ports:
      - '\${OMNARR_PEER_PORT:-6881}:\${QBT_TORRENTING_PORT:-50000}/udp'
      - '\${OMNARR_WEBUI_PORT:-9090}:9090'
`),
    ).toEqual(['qb: publishes the qBittorrent WebUI port 9090']);
  });

  test('passes a client on another service’s network', () => {
    expect(check(`services:\n  qb:\n    image: qbittorrentofficial/qbittorrent-nox\n    network_mode: service:gluetun\n`)).toEqual([]);
  });

  test('merges the override over the base, with !reset clearing a key', () => {
    expect(
      checkVpn(
        BASE,
        `
services:
  gluetun:
    image: qmcgaw/gluetun:v3.41.3
    networks: [internal]
  qbittorrent:
    network_mode: service:gluetun
    networks: !reset null
    ports: !reset []
`,
      ),
    ).toEqual([]);
  });

  test('fails qBittorrent’s peer port kept in the VPN layout', () => {
    expect(checkVpn(BASE, `services:\n  qbittorrent:\n    network_mode: service:gluetun\n    networks: !reset null\n`)).toEqual([
      'qbittorrent: publishes port 6881; qBittorrent publishes no port in the VPN layout',
      'qbittorrent: publishes port 6881; qBittorrent publishes no port in the VPN layout',
    ]);
  });

  test('fails a client on the host network', () => {
    expect(check(`services:\n  nzbget:\n    image: nzbgetcom/nzbget\n    network_mode: host\n`)).toEqual([
      'nzbget: uses network_mode: host, which publishes every port',
    ]);
  });
});

describe('shippedViolations', () => {
  const DIGEST = '@sha256:' + 'a'.repeat(64);
  const SHIPPED = `
services:
  setup:
    image: ghcr.io/dev-marzahn/omnarr-worker:0.1.0${DIGEST}
  backend:
    image: ghcr.io/dev-marzahn/omnarr-backend:0.1.0${DIGEST}
    ports: ['\${OMNARR_BIND_ADDRESS:-0.0.0.0}:\${OMNARR_CONVEX_PORT:-3210}:3210', '\${OMNARR_BIND_ADDRESS:-0.0.0.0}:\${OMNARR_CONVEX_SITE_PORT:-3211}:3211']
  worker:
    image: ghcr.io/dev-marzahn/omnarr-worker:0.1.0${DIGEST}
  web:
    image: ghcr.io/dev-marzahn/omnarr-web:0.1.0${DIGEST}
    ports: ['\${OMNARR_BIND_ADDRESS:-0.0.0.0}:\${OMNARR_WEB_PORT:-3000}:3000']
  jellyfin:
    image: jellyfin/jellyfin:12.4${DIGEST}
    ports: ['\${OMNARR_BIND_ADDRESS:-0.0.0.0}:\${OMNARR_JELLYFIN_PORT:-8096}:8096']
  qbittorrent:
    image: qbittorrentofficial/qbittorrent-nox:5.3.0-2${DIGEST}
    ports: ['\${OMNARR_PEER_PORT:-6881}:6881', '\${OMNARR_PEER_PORT:-6881}:6881/udp']
`;
  const VPN = `
services:
  gluetun:
    image: qmcgaw/gluetun:v3.41.3${DIGEST}
  qbittorrent:
    network_mode: service:gluetun
    ports: !reset []
`;
  const shipped = (text: string, layout: 'direct' | 'vpn' = 'direct', override?: string) =>
    shippedViolations(override ? mergeCompose([parseCompose(text), parseCompose(override)]) : parseCompose(text), 'compose.yml', layout).map(
      (v) => `${v.service}: ${v.reason}`,
    );

  test('passes the shipped ports, all pinned, in both layouts', () => {
    expect(shipped(SHIPPED)).toEqual([]);
    expect(shipped(SHIPPED, 'vpn', VPN)).toEqual([]);
  });

  test('fails a published setup or worker port, and a second backend port', () => {
    expect(shipped(SHIPPED.replace('worker:0.1.0' + DIGEST + '\n  backend:', `worker:0.1.0${DIGEST}\n    ports: ['9000:9000']\n  backend:`))).toEqual([
      'setup: publishes port 9000; only backend:3210, backend:3211, web:3000, jellyfin:8096 and the peer port are published',
    ]);
    expect(shipped(`${SHIPPED}  worker2:\n    image: x${DIGEST}\n    ports: ['3001:3001']\n`)).toEqual([
      'worker2: publishes port 3001; only backend:3210, backend:3211, web:3000, jellyfin:8096 and the peer port are published',
    ]);
    expect(shipped(SHIPPED.replace(":3211']", ":3211', '6790:6790']"))).toEqual([
      'backend: publishes port 6790; only backend:3210, backend:3211, web:3000, jellyfin:8096 and the peer port are published',
    ]);
  });

  test('fails an image without a digest', () => {
    expect(shipped(SHIPPED.replace(`omnarr-web:0.1.0${DIGEST}`, 'omnarr-web:0.1.0'))).toEqual([
      'web: image ghcr.io/dev-marzahn/omnarr-web:0.1.0 has no @sha256: digest',
    ]);
  });

  test("fails qBittorrent's peer port in the VPN layout", () => {
    expect(shipped(SHIPPED, 'vpn', VPN.replace('    ports: !reset []\n', ''))).toEqual([
      'qbittorrent: publishes port 6881; only backend:3210, backend:3211, web:3000, jellyfin:8096 and the peer port are published',
      'qbittorrent: publishes port 6881; only backend:3210, backend:3211, web:3000, jellyfin:8096 and the peer port are published',
    ]);
  });
});

describe('composeLayouts', () => {
  test('checks every file alone and compose.vpn.yml merged over its sibling base', () => {
    expect(composeLayouts(['/r/compose.yml', '/r/compose.vpn.yml', '/r/e2e/compose.test.yml', '/r/e2e/compose.vpn.test.yml'])).toEqual([
      { files: ['/r/compose.yml'], layout: 'direct' },
      { files: ['/r/compose.yml', '/r/compose.vpn.yml'], layout: 'vpn' },
      { files: ['/r/e2e/compose.test.yml'], layout: 'direct' },
      { files: ['/r/e2e/compose.vpn.test.yml'], layout: 'direct' },
    ]);
  });

  test('checks a VPN override without a base alone in the VPN layout', () => {
    expect(composeLayouts(['/r/compose.yml', '/r/deploy/compose.vpn.yaml'])).toEqual([
      { files: ['/r/compose.yml'], layout: 'direct' },
      { files: ['/r/deploy/compose.vpn.yaml'], layout: 'vpn' },
    ]);
  });
});
