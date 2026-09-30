import { MODES, parseMode, UnknownModeError } from './scenario';

test('the modes are HAPPY plus every failure mode the mock can emit', () => {
  expect([...MODES].sort()).toEqual(
    [
      'HAPPY',
      'LATE_ISSUED',
      'FOREIGN_TICKET_SIG',
      'FIELD_MISMATCH',
      'SHORT_TTL',
      'BEYOND_DEADLINE',
      'WRONG_DRAW',
      'BAD_GATEWAY_SIG',
      'UNSUPPORTED_VERSION',
      'DROP_CONNECTION',
      'NO_ISSUED',
      'CANTON_DESTINATION',
      'UNKNOWN_S2F_TYPE',
    ].sort(),
  );
});

test.each(MODES.map((m) => [m]))('%s parses to itself', (mode) => {
  expect(parseMode(mode)).toBe(mode);
});

test('B15: an unknown mode is refused with the allowed list', () => {
  let error: unknown;
  try {
    parseMode('NO_SUCH_MODE');
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(UnknownModeError);
  expect((error as UnknownModeError).allowed).toEqual([...MODES]);
  expect((error as Error).message).toContain('NO_SUCH_MODE');
  expect((error as Error).message).toContain('LATE_ISSUED');
});

test.each([[undefined], [42], ['happy'], [' HAPPY']])('%p is not a mode', (value) => {
  expect(() => parseMode(value)).toThrow(UnknownModeError);
});
