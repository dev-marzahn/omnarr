// The gluetun reader: the worker's read-only view of the
// VPN container, in the VPN layout only. Three routes of the control server,
// with `X-API-Key`, which the key's role allows and nothing else; and
// gluetun's health server, because the control server's status stays
// `running` while a WireGuard tunnel is dead. Every failure is an Error with platform text naming
// the route, never the URL or the key. 5 s per call.
export type GluetunOptions = {
  /** `GLUETUN_URL`, the control server: http://gluetun:8000. */
  url: string;
  /** The health server: http://gluetun:9999 (`HEALTH_SERVER_ADDRESS=:9999` in compose.vpn.yml). */
  healthUrl: string;
  /** `gluetun_api_key` from the setup container's secrets. */
  apiKey: string;
  timeoutMs?: number;
};

export type GluetunReader = {
  readonly timeoutMs: number;
  /** `GET /v1/vpn/status`: `running`, `starting`, `stopped`, `crashed`, … */
  vpnStatus(signal: AbortSignal): Promise<string>;
  /** `GET /v1/publicip/ip`: the exit IP gluetun looked up, if any. Display only. */
  publicIp(signal: AbortSignal): Promise<string | undefined>;
  /** `GET /v1/portforward`: the forwarded port, 0 for none. */
  forwardedPort(signal: AbortSignal): Promise<number>;
  /** The health server's `GET /`: whether gluetun's last health check passed. */
  healthy(signal: AbortSignal): Promise<boolean>;
};

export function gluetunReader(options: GluetunOptions): GluetunReader {
  const timeoutMs = options.timeoutMs ?? 5000;
  const control = options.url.replace(/\/+$/, '');
  const health = options.healthUrl.replace(/\/+$/, '');

  async function get(url: string, where: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
    try {
      return await fetch(url, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
    } catch (error) {
      if (signal.aborted) throw error;
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new Error(timedOut ? `Gluetun did not answer in time (${where}).` : `Gluetun did not answer (${where}).`);
    }
  }

  async function json<T>(path: string, signal: AbortSignal): Promise<T> {
    const where = `GET ${path}`;
    const response = await get(`${control}${path}`, where, { 'x-api-key': options.apiKey }, signal);
    if (response.status === 401) {
      await response.body?.cancel();
      throw new Error(`Gluetun refused the control API key (${where}, HTTP 401).`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Gluetun answered HTTP ${response.status} (${where}).`);
    }
    return (await response.json()) as T;
  }

  return {
    timeoutMs,
    vpnStatus: async (signal) => (await json<{ status: string }>('/v1/vpn/status', signal)).status,
    publicIp: async (signal) => (await json<{ public_ip?: string }>('/v1/publicip/ip', signal)).public_ip || undefined,
    forwardedPort: async (signal) => (await json<{ port?: number }>('/v1/portforward', signal)).port ?? 0,
    async healthy(signal) {
      const response = await get(`${health}/`, 'GET / on the health server', {}, signal);
      // The body is gluetun's own error text, which is never passed on.
      await response.body?.cancel();
      return response.ok;
    },
  };
}
