// The VPN choice, its runtime state and the save rules. Its
// own module, beside downloadClients.ts, which carries it in the worker
// exchange and the DTO.
import { z } from 'zod';

/** The four choices of the VPN card: a config file of either kind, or a named provider with port forwarding. */
export const VpnKind = z.enum(['wireguardFile', 'openvpnFile', 'protonvpn', 'pia']);
export type VpnKind = z.infer<typeof VpnKind>;

const Port = z.number().int().min(1).max(65_535);

/**
 * The stored choice. Every field but `kind`, `serverCountries`,
 * `staticForwardedPort` and `savedAt` is internal: never in a DTO. For PIA,
 * `serverCountries` holds gluetun's regions, since PIA's servers have no
 * country.
 */
export const VpnSettings = z.object({
  kind: VpnKind,
  wireguardConf: z.string().optional(),
  openvpnConf: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  wireguardPrivateKey: z.string().optional(),
  serverCountries: z.array(z.string().min(1)).optional(),
  staticForwardedPort: Port.optional(),
  savedAt: z.number(),
});
export type VpnSettings = z.infer<typeof VpnSettings>;

const choice = { serverCountries: z.array(z.string()).optional(), staticForwardedPort: Port.optional() };

/**
 * `saveVpn`'s input, one shape per kind. An absent secret keeps the
 * stored one of the same kind, as an indexer's key does.
 */
export const VpnSettingsInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('wireguardFile'), wireguardConf: z.string().optional(), staticForwardedPort: Port.optional() }).strict(),
  z
    .object({
      kind: z.literal('openvpnFile'),
      openvpnConf: z.string().optional(),
      username: z.string().optional(),
      password: z.string().optional(),
      staticForwardedPort: Port.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('protonvpn'), wireguardPrivateKey: z.string().optional(), ...choice }).strict(),
  z.object({ kind: z.literal('pia'), username: z.string().optional(), password: z.string().optional(), ...choice }).strict(),
]);
export type VpnSettingsInput = z.infer<typeof VpnSettingsInput>;

/** The VPN's state. */
export const VpnState = z.enum(['off', 'notActive', 'connecting', 'up', 'down']);
export type VpnState = z.infer<typeof VpnState>;

/** The peer port under the VPN, evaluated only while the state is `up`. */
export const PortState = z.object({ kind: z.enum(['forwarded', 'static', 'waiting', 'none']), port: Port.optional() });
export type PortState = z.infer<typeof PortState>;

/** What the worker's VPN monitor last saw. `publicIp` is display only. */
export const VpnRuntime = z.object({
  state: VpnState,
  /** The worker runs in the VPN layout while no VPN is chosen: torrents still go through it. */
  layoutWithoutChoice: z.boolean(),
  publicIp: z.string().optional(),
  port: PortState,
  /**
   * Not up, and every reading since the tunnel stopped passing was `running` with health 200 but no public IP:
   * the tunnel may work and only gluetun's exit-IP lookup have failed, so `vpnDown` adds the restart step.
   * A crash, a failing health check or no answer clears it.
   */
  exitIpMissing: z.literal(true).optional(),
  checkedAt: z.number(),
});
export type VpnRuntime = z.infer<typeof VpnRuntime>;

type Check = { ok: true } | { ok: false; message: string };

/** `[Section]` → its `key = value` pairs, keys lowercased, as wg-quick reads the file. */
function sections(text: string): { name: string; keys: Map<string, string> }[] {
  const out: { name: string; keys: Map<string, string> }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header) out.push({ name: header[1]!.trim().toLowerCase(), keys: new Map() });
    else if (line.includes('=') && out.length > 0) {
      const at = line.indexOf('=');
      out.at(-1)!.keys.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
    }
  }
  return out;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** The host of `host:port` or `[v6]:port`, and whether it is an IP literal. */
function endpointIsIp(endpoint: string): boolean {
  const v6 = /^\[([0-9a-fA-F:.]+)\]:\d+$/.exec(endpoint);
  if (v6) return v6[1]!.includes(':');
  const at = endpoint.lastIndexOf(':');
  return at > 0 && IPV4.test(endpoint.slice(0, at));
}

/**
 * The check of a WireGuard config file: an `[Interface]` `PrivateKey`,
 * and a `[Peer]` `Endpoint` whose host is an IP address, because gluetun's
 * custom WireGuard doesn't resolve names.
 */
export function validateWireguardConf(text: string): Check {
  const parsed = sections(text);
  if (!parsed.some((s) => s.name === 'interface' && s.keys.get('privatekey'))) return { ok: false, message: 'The config has no [Interface] PrivateKey.' };
  const endpoint = parsed.find((s) => s.name === 'peer' && s.keys.get('endpoint'))?.keys.get('endpoint');
  if (!endpoint) return { ok: false, message: 'The config has no [Peer] Endpoint.' };
  if (!endpointIsIp(endpoint))
    return { ok: false, message: 'The [Peer] Endpoint must be an IP address, not a hostname: the VPN container doesn’t resolve names for it.' };
  return { ok: true };
}

const SECRETS = ['wireguardConf', 'openvpnConf', 'username', 'password', 'wireguardPrivateKey'] as const;

/** What each kind can't do without, after the stored secrets are kept. */
function missing(settings: VpnSettings): string | undefined {
  switch (settings.kind) {
    case 'wireguardFile':
      return settings.wireguardConf ? undefined : 'A WireGuard config file is needed.';
    case 'openvpnFile':
      return settings.openvpnConf ? undefined : 'An OpenVPN config file is needed.';
    case 'protonvpn':
      return settings.wireguardPrivateKey ? undefined : 'ProtonVPN needs its WireGuard private key.';
    case 'pia':
      return settings.username && settings.password ? undefined : 'PIA needs its username and password.';
  }
}

/**
 * The settings `saveVpn` stores: the input, with each secret it
 * leaves out taken from the stored choice of the same kind. A choice of
 * another kind keeps nothing. Refused, with a message for the form, when the
 * kind lacks its secret or its WireGuard config fails `validateWireguardConf`.
 */
export function mergeVpnSettings(
  input: VpnSettingsInput,
  stored: VpnSettings | undefined,
  now: number,
): { ok: true; settings: VpnSettings } | { ok: false; message: string } {
  const kept = stored?.kind === input.kind ? stored : undefined;
  const settings: VpnSettings = { kind: input.kind, savedAt: now };
  const given = input as Partial<Record<(typeof SECRETS)[number], string>>;
  for (const key of SECRETS) {
    const value = given[key] ?? kept?.[key];
    if (value !== undefined && value !== '') settings[key] = value;
  }
  const countries = 'serverCountries' in input ? input.serverCountries?.map((c) => c.trim()).filter(Boolean) : undefined;
  if (countries && countries.length > 0) settings.serverCountries = countries;
  if (input.staticForwardedPort !== undefined) settings.staticForwardedPort = input.staticForwardedPort;
  const lack = missing(settings);
  if (lack) return { ok: false, message: lack };
  if (settings.kind === 'wireguardFile') {
    const check = validateWireguardConf(settings.wireguardConf!);
    if (!check.ok) return check;
  }
  return { ok: true, settings };
}
