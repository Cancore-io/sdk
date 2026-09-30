import { CancoreApiError } from './http';
import { refusalForCode, refusalOf, type Refusal } from './refusal';
import { SDK_ERROR_CODES, type SdkErrorCode } from './sdk-error-codes';

const refused = (status: number, body: unknown) => new CancoreApiError(status, 'POST', '/wallet/operations/submit', body);

describe('refusalOf, by code', () => {
  test.each<[SdkErrorCode, Refusal]>([
    ['SUBMISSION_TIMEOUT_RETRYABLE', 'retrySameSignatures'],
    ['PREPARED_SUBMISSION_EXPIRED', 'rerunCeremony'],
    ['WALLET_TOO_FRAGMENTED', 'mergeThenRetry'],
    ['COUNTER_PROPOSAL_NOT_READY', 'counterNotReady'],
    ['COUNTER_PROPOSAL_ALREADY_ACCEPTED', 'counterAlreadyAccepted'],
    ['SWAP_ALREADY_SETTLED', 'alreadySettled'],
  ])('%s is %s, whatever the text says', (code, expected) => {
    expect(refusalOf(refused(400, { errorCode: code, code, message: 'wording the API may change tomorrow' }))).toBe(expected);
  });

  test('the same holds when an older gateway sends code alone', () => {
    expect(refusalOf(refused(400, { code: 'SUBMISSION_TIMEOUT_RETRYABLE', message: 'x' }))).toBe('retrySameSignatures');
  });

  test('a code nobody here acts on is other', () => {
    expect(refusalOf(refused(409, { errorCode: 'KEY_IN_USE', message: 'x' }))).toBe('other');
  });

  test('a body with a known code is never read as prose', () => {
    // The text names another condition: the code decides.
    expect(refusalOf(refused(400, { errorCode: 'KEY_IN_USE', message: 'submission timed out — safe to retry' }))).toBe('other');
    expect(refusalOf(refused(400, { errorCode: 'PREPARED_SUBMISSION_EXPIRED', message: 'safe to retry' }))).toBe('rerunCeremony');
  });

  test('every code in the generated list has a branch', () => {
    for (const code of SDK_ERROR_CODES) expect(() => refusalForCode(code)).not.toThrow();
  });
});

describe('refusalOf, with no code on the body (prose fallback for a gateway that does not send one)', () => {
  test.each<[number, string, Refusal]>([
    [400, 'submission timed out — safe to retry with the same signature', 'retrySameSignatures'],
    [400, 'No pending accept-deposit submission found for this key', 'rerunCeremony'],
    [409, 'Wallet too fragmented: the deposit leg needs more holdings', 'mergeThenRetry'],
    [400, 'Counter proposal not found on swap', 'counterNotReady'],
    [400, 'Counter proposal already accepted', 'counterAlreadyAccepted'],
    [400, 'swap is both_claimed', 'alreadySettled'],
  ])('%i "%s" is %s', (status, message, expected) => {
    expect(refusalOf(refused(status, { statusCode: status, message }))).toBe(expected);
  });

  test('the status still has to match', () => {
    expect(refusalOf(refused(500, { message: 'safe to retry' }))).toBe('other');
  });

  test('an unknown code from a newer gateway is read by its text, like no code', () => {
    expect(refusalOf(refused(400, { errorCode: 'SOME_FUTURE_CODE', message: 'timed out — safe to retry' }))).toBe('retrySameSignatures');
  });

  test('an unknown code from a newer gateway with no known prose is other', () => {
    expect(refusalOf(refused(400, { errorCode: 'SOME_FUTURE_CODE', message: 'something new' }))).toBe('other');
  });
});

describe('refusalOf, on anything else', () => {
  test.each([['an Error', new Error('safe to retry')], ['undefined', undefined], ['a string', 'safe to retry']])('%s is other', (_n, err) => {
    expect(refusalOf(err)).toBe('other');
  });
});

describe('the registry is closed', () => {
  test('a code added to the union without a branch does not compile', () => {
    // A refresh that adds a code widens `SdkErrorCode`; `refusalForCode` ends in `assertNever(code)`,
    // so tsc stops on it. Here the widening is simulated from outside: the parameter is exactly the union.
    const future = 'NEW_CODE_FOR_TEST' as SdkErrorCode | 'NEW_CODE_FOR_TEST';
    // @ts-expect-error — the parameter type is the generated union, nothing wider
    expect(() => refusalForCode(future)).toThrow(/NEW_CODE_FOR_TEST/);
  });
});
