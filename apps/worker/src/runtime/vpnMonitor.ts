// The VPN monitor: turns gluetun's readings into the VPN
// state and port state on every reconciler pass, and keeps qBittorrent's
// `listen_port` on the forwarded (or static) port. The layout is a fact of the
// deployment: a gluetun reader (GLUETUN_URL) means the VPN layout.
//
// A reading passes when gluetun's status is `running`, its health check
// passes, *and* it knows its public IP. The status stays `running` while a
// WireGuard tunnel is dead, which the health check shows; an OpenVPN process
// that exits on a TLS error leaves the health server at its last 200, but
// gluetun clears the public IP on every VPN stop and looks it up again only
// through a new tunnel (test/fixtures/gluetun/README.md). Not passing for
// less than `vpnDownAfterMs` is `connecting`, then `down`. The down timer clears, and
// `down` gives way to `up`, only once readings have passed for `vpnStableMs`,
// so a tunnel that comes and goes still reaches `down`. The port is
// evaluated only while up, so "no port" is never "VPN down".
import { DEFAULT_LIMITS, type Limits, type PortState, type VpnRuntime, type VpnSettings, type VpnState } from '@omnarr/contracts';

import type { GluetunReader } from '../clients/gluetun.ts';

export type VpnMonitorOptions = {
  /** Set in the VPN layout only. */
  gluetun?: GluetunReader;
  /** `QBITTORRENT_PEER_PORT`: what qBittorrent listens on without a forwarded or static port. */
  peerPort: number;
  /** qBittorrent's `app/setPreferences { listen_port }`, without a restart. */
  setListenPort: (port: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  /** `vpnDownAfterMs`, `vpnStableMs` and `portForwardWaitMs`; the e2e lowers the first two (`OMNARR_TEST_LIMITS`). */
  limits?: Limits;
  log?: (message: string) => void;
};

/** The kinds whose provider forwards a port through gluetun. */
const FORWARDS = new Set<VpnSettings['kind']>(['protonvpn', 'pia']);

export class VpnMonitor {
  private readonly now: () => number;
  private readonly limits: Limits;
  private state: VpnState = 'off';
  /** Since when the VPN layout hasn't been up, for `connecting` → `down`; kept until readings pass for `vpnStableMs`. */
  private notUpSince?: number;
  /** Since when every reading has passed, for the stable window. */
  private passingSince?: number;
  /** Every failing reading since `notUpSince` was `running` and healthy, only without a public IP. */
  private exitIpOnly = false;
  /** Since when it has been up, for the port wait. */
  private upSince?: number;
  /** The port the last successful set gave qBittorrent. */
  private setPort?: number;
  /** A transition to `up` whose port hasn't been set yet. */
  private setDue = false;

  public constructor(private readonly options: VpnMonitorOptions) {
    this.now = options.now ?? Date.now;
    this.limits = options.limits ?? DEFAULT_LIMITS;
  }

  /** Whether the worker runs in the VPN layout. */
  public get vpnLayout(): boolean {
    return this.options.gluetun !== undefined;
  }

  /** Torrents wait while a chosen VPN, or the VPN layout, isn't up. */
  public gated(): boolean {
    return this.state !== 'off' && this.state !== 'up';
  }

  /** The port qBittorrent should listen on, for the qBittorrent apply. */
  public listenPort(): number {
    return this.setPort ?? this.options.peerPort;
  }

  /** One pass's reading. */
  public async read(chosen: VpnSettings | undefined, signal: AbortSignal): Promise<VpnRuntime> {
    const { gluetun } = this.options;
    const now = this.now();
    if (!gluetun) {
      this.state = chosen ? 'notActive' : 'off';
      return { state: this.state, layoutWithoutChoice: false, port: { kind: 'none' }, checkedAt: now };
    }
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(gluetun.timeoutMs * 2)]);
    const [status, healthy, publicIp] = await Promise.all([gluetun.vpnStatus(timeout), gluetun.healthy(timeout), gluetun.publicIp(timeout)]).catch(
      () => [undefined, false, undefined] as const,
    );
    /** The public IP of a passing reading, or undefined. */
    const reading = status === 'running' && healthy && publicIp ? publicIp : undefined;
    const layoutWithoutChoice = chosen === undefined;
    const notUp = (): VpnRuntime => ({
      state: this.state,
      layoutWithoutChoice,
      port: { kind: 'none' },
      ...(this.exitIpOnly ? { exitIpMissing: true as const } : {}),
      checkedAt: now,
    });
    if (reading === undefined) {
      // Only a tunnel that has answered `running` and healthy at every failing reading may just lack its exit IP.
      const exitIpOnly = status === 'running' && healthy;
      this.exitIpOnly = this.notUpSince === undefined ? exitIpOnly : this.exitIpOnly && exitIpOnly;
      this.notUpSince ??= now;
      this.passingSince = undefined;
      this.upSince = undefined;
      this.state = now - this.notUpSince >= this.limits.vpnDownAfterMs ? 'down' : 'connecting';
      return notUp();
    }
    this.passingSince ??= now;
    if (now - this.passingSince >= this.limits.vpnStableMs) this.notUpSince = undefined;
    else if (this.state === 'down') return notUp();
    if (this.state !== 'up') {
      this.upSince = now;
      this.setDue = true;
    }
    this.state = 'up';
    const forwarded = await gluetun.forwardedPort(timeout).catch(() => 0);
    const port = this.portState(chosen, forwarded, now);
    await this.setListen(port.port ?? this.options.peerPort, signal);
    return { state: 'up', layoutWithoutChoice, publicIp: reading, port, checkedAt: now };
  }

  private portState(chosen: VpnSettings | undefined, forwarded: number, now: number): PortState {
    if (forwarded > 0) return { kind: 'forwarded', port: forwarded };
    if (chosen?.staticForwardedPort !== undefined) return { kind: 'static', port: chosen.staticForwardedPort };
    if (chosen && FORWARDS.has(chosen.kind) && now - (this.upSince ?? now) < this.limits.portForwardWaitMs) return { kind: 'waiting' };
    return { kind: 'none' };
  }

  /** Sets `listen_port` on a transition to up and on a change; a failure is tried again next pass. */
  private async setListen(port: number, signal: AbortSignal): Promise<void> {
    if (!this.setDue && port === this.setPort) return;
    try {
      await this.options.setListenPort(port, signal);
      this.setPort = port;
      this.setDue = false;
    } catch (error) {
      this.options.log?.(`vpn: listen port not set (${(error as Error).message})`);
    }
  }
}
