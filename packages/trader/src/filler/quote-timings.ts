import type { Clock } from './runtime';

/**
 * Where the time of one `quote.request` went, for the log: the whole path from
 * filler-gateway to the filler and back must fit in the auction window
 * (`windowCloseAt`), so a late quote is only explained by its steps.
 */
export class QuoteTimings {
  private readonly receivedAtMs: number;
  private readonly steps: Record<string, number> = {};

  constructor(
    private readonly clock: Clock,
    private readonly windowCloseAt: number | undefined,
  ) {
    this.receivedAtMs = clock.now();
  }

  async measure<T>(step: string, run: () => Promise<T>): Promise<T> {
    const startedAtMs = this.clock.now();
    try {
      return await run();
    } finally {
      this.steps[step] = this.clock.now() - startedAtMs;
    }
  }

  fields(): Record<string, number> {
    return {
      ...(this.windowCloseAt !== undefined ? { windowLeftAtReceiptMs: this.windowCloseAt - this.receivedAtMs } : {}),
      ...this.steps,
      elapsedMs: this.clock.now() - this.receivedAtMs,
    };
  }
}
