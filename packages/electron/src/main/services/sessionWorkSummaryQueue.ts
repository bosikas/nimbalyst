/** One background inference at a time; duplicates coalesce, newer turns are not lost. */
export class SessionWorkSummaryQueue {
  private pending = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active = false;
  private stopped = false;
  constructor(private readonly run: (sessionId: string, workspacePath: string) => Promise<boolean>, private readonly failed: (error: unknown) => void, private readonly delay = 1500) {}

  request(sessionId: string, workspacePath: string): void {
    if (this.stopped) return;
    this.pending.set(sessionId, workspacePath);
    if (!this.active && !this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.drain(); }, this.delay);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
  }

  private async drain(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      while (!this.stopped && this.pending.size) {
        const [id, workspace] = this.pending.entries().next().value!;
        this.pending.delete(id);
        try {
          if (await this.run(id, workspace) && !this.stopped) this.pending.set(id, workspace);
        } catch (error) { this.failed(error); }
      }
    } finally { this.active = false; }
  }
}
