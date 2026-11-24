// Fails if a compose file publishes a download client's port. The clients'
// control plane stays on the internal network:
//
// - gluetun and NZBGet publish no port;
// - qBittorrent publishes only its peer port (QBT_TORRENTING_PORT, default
//   6881), and only in the direct layout; its WebUI port is QBT_WEBUI_PORT
//   (default 8080);
// - a client may use `network_mode: service:<name>`, never `host`.
//
// Jellyfin's port is published on purpose: users open Jellyfin to watch.
// `${VAR:-default}` resolves to its default, and `!reset` clears a key.
//
// Layouts: every compose file in the repository is checked alone in the direct
// layout, except a VPN override (`compose.vpn.yml`, also `.yaml` and the
// `docker-compose.` prefix). That is merged over the base file beside it
// (`compose.yml`), as `docker compose -f compose.yml -f compose.vpn.yml` merges
// them, and checked in the VPN layout; `compose.vpn.merged.yml`, the two in one
// file, is checked alone in the VPN layout. Other files, such as
// `e2e/compose.vpn.test.yml`, are checked alone.
//
//   node scripts/check-ports.ts
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type CollectionTag, parse, Scalar, type ScalarTag } from 'yaml';

type Environment = Record<string, string>;
type Client = { name: string; image: RegExp; webUiPort?: (environment: Environment) => number; peerPort?: (environment: Environment) => number };

const CLIENTS: Client[] = [
  // Carries qBittorrent's network in the VPN layout; its control API and the WebUI stay internal.
  { name: 'gluetun', image: /gluetun/i },
  { name: 'NZBGet', image: /nzbget/i, webUiPort: () => 6789 },
  // qbittorrent-nox moves the WebUI with QBT_WEBUI_PORT and the peer port with QBT_TORRENTING_PORT.
  {
    name: 'qBittorrent',
    image: /qbittorrent/i,
    webUiPort: (env) => Number(env.QBT_WEBUI_PORT ?? 8080),
    peerPort: (env) => Number(env.QBT_TORRENTING_PORT ?? 6881),
  },
];

/**
 * A compose file as the check reads it: `${VAR:-default}` and `${VAR-default}` resolve to their
 * default (the shipped layout, never this machine's environment) and `$$` to `$`.
 */
export function parseCompose(text: string): unknown {
  return interpolate(parse(text, { customTags: [reset(), reset('seq'), reset('map')] }));
}

/** What `!reset` parses to: an empty value that clears the key it overrides (see mergeCompose). */
const RESET = Symbol('!reset');

function reset(collection?: 'seq' | 'map'): ScalarTag | CollectionTag {
  const tag = { tag: '!reset', resolve: () => new Scalar(RESET) };
  return (collection ? { ...tag, collection } : tag) as ScalarTag | CollectionTag;
}

/**
 * Compose files merged in order, as `docker compose -f base -f override` merges them: mappings
 * merge by key, sequences append, scalars are replaced, and `!reset` removes the key.
 */
export function mergeCompose(files: unknown[]): unknown {
  return files.reduce<unknown>((merged, file) => merge(merged, file), undefined);
}

function merge(base: unknown, override: unknown): unknown {
  if (Array.isArray(base) && Array.isArray(override)) return [...base, ...override];
  if (isMapping(base) && isMapping(override)) {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
      if (value === RESET) delete merged[key];
      else merged[key] = merge(base[key], value);
    }
    return merged;
  }
  return override === RESET ? undefined : isMapping(override) ? merge({}, override) : override;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function interpolate(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\$\$|\$\{\w+:?-([^}]*)\}/g, (match, fallback?: string) => (match === '$$' ? '$' : fallback!));
  if (Array.isArray(value)) return value.map(interpolate);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, interpolate(v)]));
  return value;
}

export type Violation = { file: string; service: string; reason: string };

type Service = { image?: string; ports?: unknown[]; environment?: Record<string, unknown> | string[]; network_mode?: string };

function environmentOf(service: Service): Record<string, string> {
  const env = service.environment;
  if (Array.isArray(env)) return Object.fromEntries(env.map((entry) => String(entry).split(/=(.*)/s, 2) as [string, string]));
  return Object.fromEntries(Object.entries(env ?? {}).map(([key, value]) => [key, String(value)]));
}

/** The container ports a `ports:` entry publishes, as [first, last]. */
function containerPorts(entry: unknown): [number, number] | undefined {
  if (typeof entry === 'object' && entry !== null) {
    const target = (entry as { target?: unknown }).target;
    return typeof target === 'number' || typeof target === 'string' ? range(String(target)) : undefined;
  }
  // [host_ip:][host_port:]container_port[/protocol], ranges as a-b
  const withoutProtocol = String(entry).split('/')[0]!;
  return range(withoutProtocol.split(':').at(-1)!);
}

function range(spec: string): [number, number] | undefined {
  const [first, last] = spec.split('-').map(Number);
  if (first === undefined || Number.isNaN(first)) return undefined;
  if (last === undefined) return [first, first];
  return Number.isNaN(last) ? undefined : [first, last];
}

/** The layouts: `direct` is the base file alone, `vpn` the base with `compose.vpn.yml` merged over it. */
export type Layout = 'direct' | 'vpn';

export function publishedWebUiPorts(compose: unknown, file: string, layout: Layout = 'direct'): Violation[] {
  const services = (compose as { services?: Record<string, Service> } | null)?.services ?? {};
  const violations: Violation[] = [];
  for (const [name, service] of Object.entries(services)) {
    const client = CLIENTS.find((c) => service.image && c.image.test(service.image));
    if (!client) continue;
    if (service.network_mode === 'host') {
      violations.push({ file, service: name, reason: 'uses network_mode: host, which publishes every port' });
      continue;
    }
    const environment = environmentOf(service);
    const port = client.webUiPort?.(environment);
    // Only the direct layout publishes the peer port; in the VPN layout peers arrive through gluetun's tunnel.
    const peerPort = layout === 'direct' ? client.peerPort?.(environment) : undefined;
    for (const entry of service.ports ?? []) {
      const published = containerPorts(entry);
      if (port !== undefined && published && published[0] <= port && port <= published[1]) {
        violations.push({ file, service: name, reason: `publishes the ${client.name} WebUI port ${port}` });
      } else if (peerPort === undefined || !(published && published[0] === peerPort && published[1] === peerPort)) {
        const shown = published ? (published[0] === published[1] ? `${published[0]}` : `${published[0]}-${published[1]}`) : String(entry);
        const rule =
          peerPort !== undefined ? `publishes only its peer port ${peerPort}` : client.peerPort ? 'publishes no port in the VPN layout' : 'publishes no port';
        violations.push({ file, service: name, reason: `publishes port ${shown}; ${client.name} ${rule}` });
      }
    }
  }
  return violations;
}

/** The shipped files' published container ports, by compose key; qBittorrent's peer port only in the direct layout. */
const SHIPPED_PORTS: Record<string, number[]> = { backend: [3210, 3211], web: [3000], jellyfin: [8096] };
const SHIPPED_RULE = 'only backend:3210, backend:3211, web:3000, jellyfin:8096 and the peer port are published';

/**
 * The rules for the root `compose.yml` and `compose.vpn.yml`: only the ports
 * above are published, and every image is pinned by digest. The client rules
 * (publishedWebUiPorts) apply as well.
 */
export function shippedViolations(compose: unknown, file: string, layout: Layout): Violation[] {
  const services = (compose as { services?: Record<string, Service> } | null)?.services ?? {};
  const violations: Violation[] = [];
  for (const [name, service] of Object.entries(services)) {
    if (service.image && !service.image.includes('@sha256:')) violations.push({ file, service: name, reason: `image ${service.image} has no @sha256: digest` });
    const allowed = [...(SHIPPED_PORTS[name] ?? [])];
    if (name === 'qbittorrent' && layout === 'direct') allowed.push(Number(environmentOf(service).QBT_TORRENTING_PORT ?? 6881));
    for (const entry of service.ports ?? []) {
      const published = containerPorts(entry);
      if (published && published[0] === published[1] && allowed.includes(published[0])) continue;
      const shown = published ? (published[0] === published[1] ? `${published[0]}` : `${published[0]}-${published[1]}`) : String(entry);
      violations.push({ file, service: name, reason: `publishes port ${shown}; ${SHIPPED_RULE}` });
    }
  }
  return violations;
}

const SKIP = new Set(['node_modules', '.git', 'docs', '.nuxt', '.output', 'dist']);

/** Every compose file in the repository: compose*.y(a)ml and docker-compose*.y(a)ml. */
export function composeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return SKIP.has(entry.name) ? [] : composeFiles(join(dir, entry.name));
    return /^(docker-)?compose[\w.-]*\.ya?ml$/.test(entry.name) ? [join(dir, entry.name)] : [];
  });
}

const OVERRIDE = /^((?:docker-)?compose)\.vpn\.ya?ml$/;
const MERGED = /^(?:docker-)?compose\.vpn\.merged\.ya?ml$/;

/**
 * The layouts to check: every compose file alone in the direct layout, except a VPN override
 * (`compose.vpn.y(a)ml`, `docker-compose.vpn.y(a)ml`), which is merged over its sibling base
 * (`compose.y(a)ml`, `docker-compose.y(a)ml` in the same folder) in the VPN layout, or checked
 * alone in the VPN layout when it has none. The VPN layout in one file (`compose.vpn.merged.y(a)ml`)
 * is checked alone in the VPN layout.
 */
export function composeLayouts(files: string[]): { files: string[]; layout: Layout }[] {
  return files.map((file) => {
    if (MERGED.test(basename(file))) return { files: [file], layout: 'vpn' };
    const override = OVERRIDE.exec(basename(file));
    if (!override) return { files: [file], layout: 'direct' };
    const base = files.find((f) => dirname(f) === dirname(file) && new RegExp(`^${override[1]}\\.ya?ml$`).test(basename(f)));
    return { files: base ? [base, file] : [file], layout: 'vpn' };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(fileURLToPath(import.meta.url), '../..');
  const files = composeFiles(root);
  const violations = composeLayouts(files).flatMap(({ files: layoutFiles, layout }) => {
    const merged = mergeCompose(layoutFiles.map((file) => parseCompose(readFileSync(file, 'utf8'))));
    const name = layoutFiles.map((file) => relative(root, file)).join(' + ');
    // The shipped files at the root.
    const shipped = layoutFiles.every((file) => dirname(file) === root);
    return [...publishedWebUiPorts(merged, name, layout), ...(shipped ? shippedViolations(merged, name, layout) : [])];
  });
  for (const v of violations) console.error(`${v.file}: ${v.service} ${v.reason}`);
  if (violations.length > 0) process.exit(1);
  console.log(`No client publishes a port it shouldn't (${files.length} compose file${files.length === 1 ? '' : 's'} checked).`);
}
