import { Clock } from './clock';

describe('frozen clock', () => {
  test('stands still until advanced', () => {
    const clock = new Clock({ mode: 'frozen', baseMs: 1_000 });
    expect(clock.now()).toBe(1_000);
    clock.advance(250);
    expect(clock.now()).toBe(1_250);
  });

  test('advance fires every task due by the new time, in time order, ties first-come', () => {
    const clock = new Clock({ mode: 'frozen', baseMs: 0 });
    const fired: string[] = [];
    clock.schedule(30, () => fired.push('c'));
    clock.schedule(10, () => fired.push('a'));
    clock.schedule(10, () => fired.push('b'));
    clock.schedule(31, () => fired.push('late'));
    clock.advance(30);
    expect(fired).toEqual(['a', 'b', 'c']);
  });

  test('a task fires exactly at its time, not one millisecond early', () => {
    const clock = new Clock({ mode: 'frozen', baseMs: 0 });
    const fired: number[] = [];
    clock.schedule(100, () => fired.push(clock.now()));
    clock.advance(99);
    expect(fired).toEqual([]);
    clock.advance(1);
    expect(fired).toEqual([100]);
  });

  test('a task sees the clock at its own time, and tasks it schedules inside the step fire in the same advance', () => {
    const clock = new Clock({ mode: 'frozen', baseMs: 0 });
    const seen: number[] = [];
    const tick = () => {
      seen.push(clock.now());
      clock.schedule(clock.now() + 10, tick);
    };
    clock.schedule(10, tick);
    clock.advance(35);
    expect(seen).toEqual([10, 20, 30]);
    expect(clock.now()).toBe(35);
  });

  test('cancel stops a task', () => {
    const clock = new Clock({ mode: 'frozen', baseMs: 0 });
    const fired: string[] = [];
    const cancel = clock.schedule(5, () => fired.push('x'));
    cancel();
    clock.advance(10);
    expect(fired).toEqual([]);
  });

  test('a task already due runs on the next microtask, without an advance', async () => {
    const clock = new Clock({ mode: 'frozen', baseMs: 50 });
    const fired: string[] = [];
    clock.schedule(50, () => fired.push('now'));
    expect(fired).toEqual([]);
    await Promise.resolve();
    expect(fired).toEqual(['now']);
  });

  test('reset returns to a base and drops every pending task', () => {
    const clock = new Clock({ mode: 'frozen', baseMs: 0 });
    const fired: string[] = [];
    clock.schedule(5, () => fired.push('x'));
    clock.advance(3);
    clock.reset(1_000);
    expect(clock.now()).toBe(1_000);
    clock.advance(10);
    expect(fired).toEqual([]);
  });

  test('advance refuses a negative step', () => {
    expect(() => new Clock({ mode: 'frozen', baseMs: 0 }).advance(-1)).toThrow(RangeError);
  });
});

describe('real clock', () => {
  beforeEach(() => jest.useFakeTimers({ now: 5_000 }));
  afterEach(() => jest.useRealTimers());

  test('follows wall time plus the advanced offset', () => {
    const clock = new Clock({ mode: 'real', baseMs: 0 });
    expect(clock.now()).toBe(5_000);
    jest.advanceTimersByTime(100);
    expect(clock.now()).toBe(5_100);
    clock.advance(1_000);
    expect(clock.now()).toBe(6_100);
  });

  test('fires tasks on a real timer, and on advance when the offset makes them due', () => {
    const clock = new Clock({ mode: 'real', baseMs: 0 });
    const fired: string[] = [];
    clock.schedule(5_050, () => fired.push('timer'));
    clock.schedule(9_000, () => fired.push('advance'));
    jest.advanceTimersByTime(50);
    expect(fired).toEqual(['timer']);
    clock.advance(4_000);
    expect(fired).toEqual(['timer', 'advance']);
    jest.advanceTimersByTime(10_000);
    expect(fired).toEqual(['timer', 'advance']);
  });
});
