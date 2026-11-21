// The client runtime store: the reconciler writes the latest
// `downloadClients.desired` and which clients it configured this session; the
// `download.submit` handler reads it. It holds nothing Convex and the clients
// don't, and starts each worker session with every client unconfigured.
// `withClientLock` serializes an apply with that client's submit and remove
// calls, so NZBGet's `reload` never lands in the middle of an `append`.
// It also holds the VPN state of the reconciler's last pass, for the
// `download.submit` VPN gate.
import type { ClientKind, DesiredClientConfig, VpnState } from '@omnarr/contracts';

export class ClientRuntimeStore {
  private latest = new Map<ClientKind, DesiredClientConfig>();
  private configuredKinds = new Set<ClientKind>();
  private locks = new Map<ClientKind, Promise<unknown>>();
  private vpn: VpnState = 'off';

  /** A new worker session: nothing is configured until the reconciler's first apply. */
  public newSession(): void {
    this.configuredKinds.clear();
    this.vpn = 'off';
  }

  public setVpnState(state: VpnState): void {
    this.vpn = state;
  }

  public vpnState(): VpnState {
    return this.vpn;
  }

  /** Torrents wait while a chosen VPN, or the VPN layout, isn't up. */
  public vpnGated(): boolean {
    return this.vpn !== 'off' && this.vpn !== 'up';
  }

  public setDesired(entries: DesiredClientConfig[]): void {
    this.latest = new Map(entries.map((entry) => [entry.kind, entry]));
  }

  public desired(kind: ClientKind): DesiredClientConfig | undefined {
    return this.latest.get(kind);
  }

  public markConfigured(kind: ClientKind): void {
    this.configuredKinds.add(kind);
  }

  public markUnconfigured(kind: ClientKind): void {
    this.configuredKinds.delete(kind);
  }

  /** Whether the reconciler applied this client's config in this worker session. */
  public configured(kind: ClientKind): boolean {
    return this.configuredKinds.has(kind);
  }

  /** Runs `fn` once every earlier call for this client has ended. */
  public withClientLock<T>(kind: ClientKind, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(kind) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    this.locks.set(
      kind,
      run.catch(() => undefined),
    );
    return run;
  }
}
