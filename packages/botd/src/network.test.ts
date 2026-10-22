import { assertNever, makeFailure, tradingNetwork } from './network';

describe('tradingNetwork', () => {
  it.each([
    ['https://api-dev.cancore.app', 'devnet'],
    ['https://api-testnet.cancore.app', 'testnet'],
    ['https://api.cancore.io', 'mainnet'],
    ['https://api.cancore.io/', 'mainnet'],
  ])('places %s on %s', (baseUrl, network) => {
    expect(tradingNetwork({ baseUrl })).toBe(network);
    expect(tradingNetwork({ baseUrl, network: network as never })).toBe(network);
  });

  it.each(['http://api.cancore.io', 'not a url', 'ftp://api-dev.cancore.app'])('refuses %s: not https', (baseUrl) => {
    expect(() => tradingNetwork({ baseUrl })).toThrow(/must be an https URL/);
  });

  it.each(['https://api.cancore.io.evil.example', 'https://cancore.io', 'https://api-staging.cancore.app', 'https://constructor', 'https://__proto__', 'https://tostring'])('refuses %s: not a Cancore API host', (baseUrl) => {
    expect(() => tradingNetwork({ baseUrl })).toThrow(/not a Cancore API host \(api-dev\.cancore\.app, api-testnet\.cancore\.app, api\.cancore\.io\)/);
  });

  it('refuses extra pins without a network label: they are trusted on one network, and a baseUrl edit must not carry them to another', () => {
    expect(() => tradingNetwork({ baseUrl: 'https://api-testnet.cancore.app', instrumentAdmins: { Amulet: ['DSO::1220aa'] } })).toThrow(/instrumentAdmins and networkFeeRecipients need `network`/);
    expect(() => tradingNetwork({ baseUrl: 'https://api-testnet.cancore.app', networkFeeRecipients: ['op::1220bb'] })).toThrow(/need `network`/);
    expect(tradingNetwork({ baseUrl: 'https://api-testnet.cancore.app', network: 'testnet', instrumentAdmins: { Amulet: ['DSO::1220aa'] }, networkFeeRecipients: ['op::1220bb'] })).toBe('testnet');
    // The testnet pins, once baseUrl moves to mainnet, stop the daemon instead of being trusted there.
    expect(() => tradingNetwork({ baseUrl: 'https://api.cancore.io', network: 'testnet', instrumentAdmins: { Amulet: ['DSO::1220aa'] } })).toThrow(/does not match/);
  });

  it('refuses a label that is not the host\'s network, in every direction', () => {
    expect(() => tradingNetwork({ baseUrl: 'https://api-dev.cancore.app', network: 'mainnet' })).toThrow('network mainnet does not match https://api-dev.cancore.app, which is devnet');
    expect(() => tradingNetwork({ baseUrl: 'https://api.cancore.io', network: 'devnet' })).toThrow(/does not match/);
    expect(() => tradingNetwork({ baseUrl: 'https://api-testnet.cancore.app', network: 'mainnet' })).toThrow(/does not match/);
  });
});

describe('makeFailure', () => {
  it.each([
    [{ status: 429 }, 'throttled'],
    [{ status: 400 }, 'refused'],
    [{ status: 409 }, 'refused'],
    [{ status: 499 }, 'refused'],
    [{ status: 408 }, 'lost'],
    [{ status: 500 }, 'lost'],
    [{ status: 503 }, 'lost'],
    [{ status: 399 }, 'lost'],
    [{ status: '429' }, 'lost'],
    [new Error('socket hang up'), 'lost'],
    [null, 'lost'],
  ])('reads %j as %s', (err, failure) => {
    expect(makeFailure(err)).toBe(failure);
  });
});

describe('assertNever', () => {
  it('throws with the variant it was handed', () => {
    expect(() => assertNever('surprise' as never)).toThrow('Unhandled variant: "surprise"');
  });
});
