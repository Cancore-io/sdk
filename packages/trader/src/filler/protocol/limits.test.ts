import { FakeClock } from '../testing';
import { parseRetryAfter, rateClassOfFrame, RateLimits } from './limits';

describe('rate limits', () => {
  test('frames fall in the classes of filler-gateway', () => {
    expect(['quote', 'quote.reconfirm.reply'].map(rateClassOfFrame)).toEqual(['quote', 'quote']);
    expect(['ticket.intent', 'ticket.decline', 'ticket.receipt', 'fill.reported'].map(rateClassOfFrame)).toEqual(['ticket', 'ticket', 'ticket', 'ticket']);
    expect(['ping', 'pong', 'error', 'future.type'].map(rateClassOfFrame)).toEqual(['service', 'service', 'service', 'service']);
  });

  test('Retry-After: delta-seconds or an HTTP date; anything else is no wait', () => {
    const now = Date.parse('2026-10-08T12:00:00Z');
    expect(parseRetryAfter('3', now)).toBe(3_000);
    expect(parseRetryAfter(' 0 ', now)).toBeUndefined();
    expect(parseRetryAfter('Thu, 08 Oct 2026 12:00:05 GMT', now)).toBe(5_000);
    expect(parseRetryAfter('Thu, 08 Oct 2026 11:59:00 GMT', now)).toBeUndefined();
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });

  test('a pause holds its class back until it ends; a shorter one does not cut a longer one', () => {
    const clock = new FakeClock();
    const limits = new RateLimits(clock);
    limits.pause('read', 5_000);
    limits.pause(['read', 'quote'], 1_000);
    expect(limits.remainingMs('read')).toBe(5_000);
    expect(limits.remainingMs('quote')).toBe(1_000);
    expect(limits.remainingMs('ticket')).toBe(0);
    expect(() => limits.check('read', 'GET /x')).toThrow(expect.objectContaining({ code: 'RATE_LIMITED', retryAfterMs: 5_000 }));
    clock.advance(5_000);
    expect(() => limits.check('read', 'GET /x')).not.toThrow();
    expect(limits.pausedUntil('read')).toBe(0);
  });
});
