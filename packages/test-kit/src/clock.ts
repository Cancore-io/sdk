/**
 * The mock's clock. Frozen (the default for tests): time moves only by
 * `advance`, so `acceptBy`, `δ_issue`, `windowCloseAt` and heartbeats are hit
 * to the millisecond without a real pause. Real (`--clock real`, for a
 * downstream e2e): wall time plus whatever was advanced; scheduled work also
 * runs on real timers. Limit of real mode: the drand rounds are synthetic
 * (the embedded real rounds cover only the frozen fixture window).
 */
export interface ClockOptions {
  mode: 'frozen' | 'real';
  baseMs: number;
}

interface Task {
  at: number;
  seq: number;
  fn: () => void;
}

export class Clock {
  private offset = 0;
  private base: number;
  private tasks: Task[] = [];
  private seq = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly opts: ClockOptions) {
    this.base = opts.baseMs;
  }

  get mode() {
    return this.opts.mode;
  }

  now(): number {
    return (this.opts.mode === 'frozen' ? this.base : Date.now()) + this.offset;
  }

  /** Move time forward by `ms` and run every task that became due, each at its own time. */
  advance(ms: number): void {
    if (ms < 0) throw new RangeError('the clock only moves forward');
    const target = this.now() + ms;
    for (let task = this.nextDue(target); task; task = this.nextDue(target)) {
      if (task.at > this.now()) this.offset += task.at - this.now();
      task.fn();
    }
    this.offset += target - this.now();
  }

  /** Run `fn` at `at` (ms). Returns a cancel function. */
  schedule(at: number, fn: () => void): () => void {
    const task: Task = { at, seq: this.seq++, fn };
    this.tasks.push(task);
    if (this.opts.mode === 'real') this.arm(at);
    else if (at <= this.now()) queueMicrotask(() => this.advance(0));
    return () => {
      this.tasks = this.tasks.filter((t) => t !== task);
    };
  }

  /** Back to `baseMs` (frozen) or wall time (real), with no pending task. */
  reset(baseMs: number): void {
    this.base = baseMs;
    this.offset = 0;
    this.tasks = [];
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private nextDue(target: number): Task | undefined {
    let best: Task | undefined;
    for (const t of this.tasks) if (t.at <= target && (!best || t.at < best.at || (t.at === best.at && t.seq < best.seq))) best = t;
    if (best) this.tasks = this.tasks.filter((t) => t !== best);
    return best;
  }

  private arm(at: number) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.advance(0);
    }, Math.max(0, at - this.now()));
    timer.unref?.();
    this.timers.add(timer);
  }
}
