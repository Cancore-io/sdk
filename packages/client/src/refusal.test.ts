import { CancoreApiError } from './http';
import { refusalForCode, refusalOf, type Refusal } from './refusal';
import { SDK_ERROR_CODES, type SdkErrorCode } from './sdk-error-codes';

const refused = (status: number, body: unknown) => new CancoreApiError(status, 'POST', '/wallet/operations/submit', body);

/** The codes the account acts on; every other code in the registry is `other` (surfaced). */
const ACTED_ON: Array<[SdkErrorCode, Refusal]> = [
  ['SUBMISSION_TIMEOUT_RETRYABLE', 'retrySameSignatures'],
  ['PREPARED_SUBMISSION_EXPIRED', 'rerunCeremony'],
  ['WALLET_TOO_FRAGMENTED', 'mergeThenRetry'],
  ['COUNTER_PROPOSAL_NOT_READY', 'counterNotReady'],
  ['COUNTER_PROPOSAL_ALREADY_ACCEPTED', 'counterAlreadyAccepted'],
  ['SWAP_ALREADY_SETTLED', 'alreadySettled'],
  ['ACCOUNT_NOT_FOUND', 'retrySignIn'],
  ['DVP_NOT_ALLOWED', 'dvpNotAllowed'],
  ['DVP_FEE_HOLDING_REQUIRED', 'feeHoldingRequired'],
  ['ACCOUNT_STOPPED', 'accountStopped'],
];

describe('refusalOf, by code', () => {
  test.each(ACTED_ON)('%s is %s, whatever the text says', (code, expected) => {
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

  const acted = new Map(ACTED_ON);
  test.each([...SDK_ERROR_CODES])('%s is decided: the action above, or other', (code) => {
    expect(refusalForCode(code)).toBe(acted.get(code) ?? 'other');
  });

  test('a fee balance too low even for a split is surfaced, never split again: another split would not help', () => {
    const body = { errorCode: 'DVP_FEE_BALANCE_INSUFFICIENT', message: 'The platform fee needs a holding of its own', payerPartyId: 'p', feeAmount: '1' };
    expect(refusalOf(refused(409, body))).toBe('other');
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
    [409, 'The platform fee needs a holding of its own: split your balance into at least two holdings and retry.', 'feeHoldingRequired'],
    // The DvP door's own words (backend DVP_FORBIDDEN_MESSAGE), for a gateway that serves no code (CAN-2400).
    [403, 'Allocation-DvP is not open to this account on this stand. A DvP trade needs a self-custody, staff/bot or allowlisted party on at least one side.', 'dvpNotAllowed'],
  ])('%i "%s" is %s', (status, message, expected) => {
    expect(refusalOf(refused(status, { statusCode: status, message }))).toBe(expected);
  });

  test('a sign-up DTO that does not take inviteCode yet is told apart from any other validation refusal', () => {
    const invalid = (errors: string[]) => refused(400, { message: 'Validation failed', errors });
    expect(refusalOf(invalid(['property inviteCode should not exist']))).toBe('redeemInviteSeparately');
    expect(refusalOf(invalid(['Invalid invite code format']))).toBe('other');
  });

  test('the status still has to match', () => {
    expect(refusalOf(refused(500, { message: 'safe to retry' }))).toBe('other');
  });

  // CAN-2400: every 403 used to be read as the DvP refusal. Only the door's own sentence is.
  test.each([
    ['self-trade', 403, 'Self-trade is not allowed: the order initiator and acceptor belong to the same person.'],
    ['documents not accepted', 403, 'The platform documents must be accepted before trading.'],
    ['a 403 that says nothing', 403, 'Forbidden'],
    ['a 403 that merely mentions DvP', 403, 'This DvP order is reserved for the user it was quoted to'],
    ['the sentence in another case', 403, 'allocation-dvp is not open to this account'],
    ['the sentence under another status', 400, 'Allocation-DvP is not open to this account on this stand.'],
    ['the sentence under a 401', 401, 'Allocation-DvP is not open to this account on this stand.'],
  ])('%s is not the DvP refusal', (_what, status, message) => {
    expect(refusalOf(refused(status, { statusCode: status, message }))).toBe('other');
  });

  test('a known code decides even when the DvP sentence is in the text', () => {
    expect(refusalOf(refused(403, { errorCode: 'MIGRATION_REQUIRED', message: 'Allocation-DvP is not open to this account on this stand.' }))).toBe('other');
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

  test('ORDER_NOT_OPEN on a conditional cancel is classified as other (not retried)', () => {
    expect(SDK_ERROR_CODES).toContain('ORDER_NOT_OPEN');
    expect(refusalForCode('ORDER_NOT_OPEN')).toBe('other');
    expect(
      refusalOf(
        refused(409, {
          errorCode: 'ORDER_NOT_OPEN',
          code: 'ORDER_NOT_OPEN',
          message: 'Order is not open, current status: accepted',
        }),
      ),
    ).toBe('other');
  });
});

