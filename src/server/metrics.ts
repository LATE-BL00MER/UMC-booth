export type AggregateEvent = "decrypt_success" | "save_intent" | "join_click";

export interface AggregateMetricsSnapshot {
  pages: number;
  downloads: number;
  decryptSuccess: number;
  saveIntent: number;
  joinClick: number;
}

export interface AggregateMetricsOptions {
  now?: () => number;
}

const emptySnapshot = (): AggregateMetricsSnapshot => ({
  pages: 0,
  downloads: 0,
  decryptSuccess: 0,
  saveIntent: 0,
  joinClick: 0,
});

export class AggregateMetrics {
  private readonly now: () => number;
  private readonly counters = emptySnapshot();
  private eventSecond: number | null = null;
  private acceptedEvents = 0;

  constructor(options: AggregateMetricsOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  record(event: AggregateEvent): boolean {
    const second = Math.floor(this.now() / 1_000);
    if (second !== this.eventSecond) {
      this.eventSecond = second;
      this.acceptedEvents = 0;
    }
    if (this.acceptedEvents >= 10) {
      return false;
    }
    this.acceptedEvents += 1;
    if (event === "decrypt_success") {
      this.counters.decryptSuccess += 1;
    } else if (event === "save_intent") {
      this.counters.saveIntent += 1;
    } else {
      this.counters.joinClick += 1;
    }
    return true;
  }

  recordPage(): void {
    this.counters.pages += 1;
  }

  recordDownload(): void {
    this.counters.downloads += 1;
  }

  snapshot(): AggregateMetricsSnapshot {
    return { ...this.counters };
  }
}
