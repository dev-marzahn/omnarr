// Progress throttled to one write every 5 s per job: the first report
// goes out at once, later ones within the window collapse into one trailing
// write of the latest value.
export class ProgressReporter {
  private lastSentAt = -Infinity;
  private pending: { fraction: number; detail?: string } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  public constructor(
    private readonly send: (fraction: number, detail?: string) => Promise<void>,
    private readonly intervalMs: number,
  ) {}

  public report(fraction: number, detail?: string): void {
    if (this.closed) return;
    this.pending = { fraction, detail };
    const wait = this.lastSentAt + this.intervalMs - Date.now();
    if (wait <= 0) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), wait);
  }

  /** Drops any pending write; called when the job ends. */
  public close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.pending = undefined;
  }

  private flush(): void {
    this.timer = undefined;
    const next = this.pending;
    if (this.closed || !next) return;
    this.pending = undefined;
    this.lastSentAt = Date.now();
    // A failed write is handled by `send` (a fencing refusal aborts the job).
    void this.send(next.fraction, next.detail);
  }
}
