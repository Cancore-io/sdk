import { CancoreApiError, createHttp, isSdkError, sdkErrorCodeOf } from './http';

describe('sdkErrorCodeOf', () => {
  test('reads errorCode from the body', () => {
    expect(sdkErrorCodeOf({ statusCode: 403, errorCode: 'MIGRATION_REQUIRED', code: 'MIGRATION_REQUIRED', message: 'm' })).toBe(
      'MIGRATION_REQUIRED',
    );
  });

  test('falls back to code when an older gateway sends no errorCode', () => {
    expect(sdkErrorCodeOf({ statusCode: 403, code: 'CC_PREAPPROVAL_REQUIRED', message: 'm' })).toBe('CC_PREAPPROVAL_REQUIRED');
  });

  test('errorCode wins when it and code disagree', () => {
    expect(sdkErrorCodeOf({ errorCode: 'KEY_IN_USE', code: 'NOT_ELIGIBLE' })).toBe('KEY_IN_USE');
  });

  test.each([
    ['an empty errorCode', { errorCode: '', code: 'KEY_IN_USE' }],
    ['a non-string errorCode', { errorCode: 42, code: 'KEY_IN_USE' }],
  ])('%s is skipped in favour of code', (_name, body) => {
    expect(sdkErrorCodeOf(body)).toBe('KEY_IN_USE');
  });

  test('a code the client does not know is undefined, not an error', () => {
    expect(sdkErrorCodeOf({ errorCode: 'SOME_FUTURE_CODE', code: 'SOME_FUTURE_CODE' })).toBeUndefined();
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['an html page', '<html>502 Bad Gateway</html>'],
    ['an array', ['errorCode', 'KEY_IN_USE']],
    ['a number', 502],
    ['wrong field types', { errorCode: 42, code: { x: 1 } }],
    ['empty strings', { errorCode: '', code: '' }],
    ['an object with neither', { message: 'sourceAmount must be positive' }],
    ['a code-shaped string', 'KEY_IN_USE'],
  ])('junk (%s) gives undefined and does not throw', (_name, body) => {
    expect(() => sdkErrorCodeOf(body)).not.toThrow();
    expect(sdkErrorCodeOf(body)).toBeUndefined();
  });
});

describe('CancoreApiError.errorCode', () => {
  test('is filled from the body', () => {
    const err = new CancoreApiError(400, 'POST', '/wallet/operations/submit', {
      statusCode: 400,
      errorCode: 'SUBMISSION_TIMEOUT_RETRYABLE',
      code: 'SUBMISSION_TIMEOUT_RETRYABLE',
      message: 'm',
    });
    expect(err.errorCode).toBe('SUBMISSION_TIMEOUT_RETRYABLE');
  });

  test('is filled from code alone (older gateway)', () => {
    expect(new CancoreApiError(409, 'POST', '/x', { code: 'KEY_IN_USE', message: 'm' }).errorCode).toBe('KEY_IN_USE');
  });

  test('a refusal without a code is not typed, and its message is unchanged', () => {
    const err = new CancoreApiError(400, 'GET', '/orders/o1', { message: 'sourceAmount must be positive' });
    expect(err.errorCode).toBeUndefined();
    expect(isSdkError(err, 'WALLET_TOO_FRAGMENTED')).toBe(false);
    expect(err.message).toBe('GET /orders/o1 → 400: sourceAmount must be positive');
  });

  test('a body that is not JSON leaves it undefined', () => {
    expect(new CancoreApiError(502, 'GET', '/x', '<html>502</html>').errorCode).toBeUndefined();
  });

  test('createHttp throws it on a coded refusal', async () => {
    const http = createHttp({
      baseUrl: 'https://api.example',
      request: async () =>
        new Response(JSON.stringify({ statusCode: 400, errorCode: 'SUBMISSION_TIMEOUT_RETRYABLE', message: 'm' }), { status: 400 }),
    });
    const err = await http.post('/wallet/operations/submit', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CancoreApiError);
    expect((err as CancoreApiError).errorCode).toBe('SUBMISSION_TIMEOUT_RETRYABLE');
    expect(isSdkError(err, 'SUBMISSION_TIMEOUT_RETRYABLE')).toBe(true);
  });
});

describe('isSdkError', () => {
  const coded = new CancoreApiError(409, 'POST', '/x', { errorCode: 'KEY_IN_USE' });

  test('is true for the same code and false for another', () => {
    expect(isSdkError(coded, 'KEY_IN_USE')).toBe(true);
    expect(isSdkError(coded, 'NOT_ELIGIBLE')).toBe(false);
  });

  test('is false for anything that is not a CancoreApiError', () => {
    expect(isSdkError(new Error('KEY_IN_USE'), 'KEY_IN_USE')).toBe(false);
    expect(isSdkError({ errorCode: 'KEY_IN_USE' }, 'KEY_IN_USE')).toBe(false);
    expect(isSdkError(undefined, 'KEY_IN_USE')).toBe(false);
  });

  test('narrows the error to the code asked about', () => {
    const e: unknown = coded;
    if (isSdkError(e, 'KEY_IN_USE')) {
      const code: 'KEY_IN_USE' = e.errorCode;
      expect(code).toBe('KEY_IN_USE');
    } else {
      throw new Error('expected a KEY_IN_USE refusal');
    }
  });
});
