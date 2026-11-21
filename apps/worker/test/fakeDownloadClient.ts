// An in-memory download client behind the DownloadClient port, so the job
// handlers and the reconciler are tested without NZBGet. The NZBGet adapter
// has its own tests against a fake JSON-RPC server.
import type { ClientKind, DesiredClientConfig, UsenetServerUsage } from '@omnarr/contracts';

import type { ClientItem, DownloadClient, FetchedRelease, SubmitOptions } from '../src/clients/downloadClient.ts';

export type FakeItem = ClientItem & { release?: FetchedRelease; category?: SubmitOptions['category']; seedGoal?: SubmitOptions['seedGoal'] };

export class FakeDownloadClient implements DownloadClient {
  public constructor(public readonly kind: ClientKind = 'nzbget') {}
  public items: FakeItem[] = [];
  public calls: string[] = [];
  /** Every config `applyConfig` was given. */
  public applied: DesiredClientConfig[] = [];
  /** Whether the next apply finds anything different. */
  public applyChanges = true;
  /** When set, every call fails as an unreachable client would. */
  public unreachable = false;
  private next = 1;

  private check(call: string) {
    this.calls.push(call);
    if (this.unreachable) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  }

  public async findByTag(correlationTag: string): Promise<ClientItem | null> {
    this.check('findByTag');
    return this.items.find((item) => item.correlationTags.includes(correlationTag)) ?? null;
  }

  public async submit(release: FetchedRelease, options: SubmitOptions): Promise<{ clientRef: string }> {
    this.check('submit');
    // A torrent is named by its info hash, as qBittorrent names it.
    const clientRef = release.kind === 'nzb' ? String(this.next++) : release.infoHash;
    this.items.push({
      clientRef,
      correlationTags: [options.correlationTag],
      stage: 'queued',
      status: { stage: 'QUEUED', progress: 0, raw: {} },
      release,
      category: options.category,
      ...(options.seedGoal ? { seedGoal: options.seedGoal } : {}),
      name: release.kind === 'nzb' ? release.name : release.infoHash,
    });
    return { clientRef };
  }

  /** Adds an item as if the platform had submitted it, without a release. */
  public add(correlationTag: string, patch: Partial<FakeItem> = {}): string {
    const clientRef = String(this.next++);
    this.items.push({ clientRef, correlationTags: [correlationTag], stage: 'queued', status: { stage: 'QUEUED', progress: 0, raw: {} }, ...patch });
    return clientRef;
  }

  public async list(): Promise<ClientItem[]> {
    this.check('list');
    return this.items.map((item) => ({ ...item, status: { ...item.status } }));
  }

  public async remove(clientRef: string): Promise<{ removed: boolean }> {
    this.check('remove');
    const before = this.items.length;
    this.items = this.items.filter((item) => item.clientRef !== clientRef);
    return { removed: this.items.length < before };
  }

  public async applyConfig(desired: DesiredClientConfig): Promise<{ applied: boolean; changed: boolean; clientVersion?: string }> {
    this.check('applyConfig');
    this.applied.push(desired);
    const changed = this.applyChanges;
    this.applyChanges = false;
    return { applied: true, changed, clientVersion: '26.3' };
  }

  /** Every `refreshTorrent` call (qBittorrent's goal nudge). */
  public refreshed: string[] = [];

  public async refreshTorrent(clientRef: string): Promise<void> {
    this.check('refreshTorrent');
    this.refreshed.push(clientRef);
  }

  /** What `enforceLimits` answers; every call's servers are kept in `limitChecks`. */
  public usage: UsenetServerUsage[] = [];
  public limitChecks: NonNullable<DesiredClientConfig['nzbget']>[] = [];
  public async enforceLimits(desired: NonNullable<DesiredClientConfig['nzbget']>): Promise<UsenetServerUsage[]> {
    this.check('enforceLimits');
    this.limitChecks.push(desired);
    return this.usage;
  }

  public async status() {
    this.calls.push('status');
    return this.unreachable ? { reachable: false } : { reachable: true, version: '26.3' };
  }

  /** Moves an item on, as the client would. */
  public set(clientRef: string, patch: Partial<FakeItem>) {
    Object.assign(
      this.items.find((item) => item.clientRef === clientRef)!,
      patch,
    );
  }
}
