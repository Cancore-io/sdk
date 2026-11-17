import { checkNeighbours, lowestVersion, satisfies, versionDoc } from './compat';

// Range grammar: `>=X.Y.Z` or `>=X.Y.Z <A.B.C` — the subset CAEF's compat-check.ts evaluates too.
describe('satisfies', () => {
  it.each([
    ['1.5.0', '>=1.5.0', true],
    ['1.4.2', '>=1.5.0', false],
    ['2.0.0', '>=1.5.0', true],
    ['1.4.0', '>=1.4.0 <2.0.0', true],
    ['1.9.9', '>=1.4.0 <2.0.0', true],
    ['2.0.0', '>=1.4.0 <2.0.0', false],
    ['1.3.9', '>=1.4.0 <2.0.0', false],
    ['10.0.0', '>=9.0.0', true],
  ])('%s in %s -> %s', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  // D6: the match is on the version core; a prerelease suffix is ignored.
  it.each([
    ['1.5.0-dev.3', '>=1.5.0', true],
    ['1.5.0-stage.1', '>=1.5.0 <2.0.0', true],
    ['1.4.9-dev.7', '>=1.5.0', false],
    ['2.0.0-dev.1', '>=1.4.0 <2.0.0', false],
  ])('prerelease %s in %s -> %s', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  it.each(['^1.2.0', '~1.2.0', '>=1.2', '>1.2.0', '>=1.2.0 || >=3.0.0', '1.2.x', '*', ''])('rejects the range %j', (range) => {
    expect(() => satisfies('1.2.0', range)).toThrow(/invalid/i);
  });
});

describe('checkNeighbours', () => {
  const required = '>=2.1.0 <3.0.0';

  // @negative: backend requires attestor >=2.1.0, the deployed one is 2.0.3.
  it('a neighbour below its range -> { neighbour, required, actual, ok: false }', () => {
    expect(checkNeighbours({ attestor: required }, { attestor: '2.0.3' })).toEqual([
      { neighbour: 'attestor', required, actual: '2.0.3', ok: false },
    ]);
  });

  it('a neighbour inside its range -> ok: true', () => {
    expect(checkNeighbours({ attestor: required }, { attestor: '2.1.4' })).toEqual([
      { neighbour: 'attestor', required, actual: '2.1.4', ok: true },
    ]);
  });

  it('1.5.0-dev.3 satisfies >=1.5.0 (D6)', () => {
    expect(checkNeighbours({ backend: '>=1.5.0' }, { backend: '1.5.0-dev.3' })[0]).toMatchObject({ ok: true, actual: '1.5.0-dev.3' });
  });

  it('keeps the order of `requires`, ignores neighbours nobody requires', () => {
    const checks = checkNeighbours({ backend: '>=1.0.0', attestor: required }, { attestor: '2.2.0', backend: '1.0.1', filler: '0.1.0' });
    expect(checks.map((c) => c.neighbour)).toEqual(['backend', 'attestor']);
  });

  it('nothing required -> nothing checked', () => {
    expect(checkNeighbours({}, { attestor: '2.0.3' })).toEqual([]);
  });

  // I4: a check never blocks, so it never throws on what a neighbour answered.
  it.each([null, 'unknown', 'v1.2', '1.2'])('an unknown or malformed actual %j -> not ok, no throw', (actual) => {
    const [check] = checkNeighbours({ attestor: required }, { attestor: actual });
    expect(check).toEqual({ neighbour: 'attestor', required, actual, ok: false });
  });

  it('a required neighbour absent from the actuals -> actual: null, not ok', () => {
    expect(checkNeighbours({ attestor: required }, {})).toEqual([{ neighbour: 'attestor', required, actual: null, ok: false }]);
  });
});

describe('versionDoc: the runtime document, one shape everywhere', () => {
  const base = { component: 'backend', service: 'gateway', version: '1.5.0', gitSha: 'a'.repeat(40), channel: 'prod', builtAt: '2026-11-17T10:00:00Z' };

  it('carries component, service, version, gitSha, channel, builtAt, requires', () => {
    expect(versionDoc({ ...base, requires: { attestor: '>=2.1.0 <3.0.0' } })).toEqual({ ...base, requires: { attestor: '>=2.1.0 <3.0.0' } });
  });

  it('requires defaults to {}, and compat is present only when a check ran', () => {
    const doc = versionDoc(base);
    expect(doc.requires).toEqual({});
    expect(doc).not.toHaveProperty('compat');
    const compat = [{ neighbour: 'attestor', required: '>=2.1.0', actual: '2.0.3', ok: false }];
    expect(versionDoc({ ...base, compat }).compat).toEqual(compat);
  });

  // I5: /version is public; attestor RPC URLs carry API keys.
  it('drops every field it does not own: no URL, no secret', () => {
    const polluted = { ...base, rpcUrl: 'https://rpc.example/key-abc', dbPassword: 's3cr3t' } as Parameters<typeof versionDoc>[0];
    const doc = versionDoc(polluted);
    expect(Object.keys(doc).sort()).toEqual(['builtAt', 'channel', 'component', 'gitSha', 'requires', 'service', 'version']);
    expect(JSON.stringify(doc)).not.toMatch(/https?:\/\/|s3cr3t/);
  });
});

// Several attestors answer for one neighbour: the weakest one decides whether the range holds.
describe('lowestVersion', () => {
  it('picks the lowest core among responders, ignoring silent and malformed ones', () => {
    expect(lowestVersion(['2.1.4', null, '2.0.3', 'unknown', '2.10.0'])).toBe('2.0.3');
  });

  it('a prerelease of the same core is not lower (D6: core match)', () => {
    expect(lowestVersion(['1.5.0', '1.5.0-dev.3'])).toBe('1.5.0');
  });

  it('nobody answered -> null', () => {
    expect(lowestVersion([null, 'v1.2'])).toBeNull();
    expect(lowestVersion([])).toBeNull();
  });
});
