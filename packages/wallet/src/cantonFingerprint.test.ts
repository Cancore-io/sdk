import { cantonFingerprint, isPartyOfKey, keyOwnsParty } from './cantonFingerprint';

// Real testnet pairs (key registered for the party, party id as Canton issued
// it) — the formula is only useful if it reproduces these exactly.
const VADIM = {
  publicKey: '72adb5543a55fe7938099a6e23163936ed7522385f7d0a2e7bc60c66612f65ae',
  partyId: 'vadim_su2f2947::1220bf6d069ee0855ed1b3a849046e7ea153c854723721095a1f5b6bd0cccaff830f',
};
const CANCORE_A = {
  publicKey: 'e0ce0542c0239315da4054489f7495c2fa2789a0571fbb30101b0617b0f671bc',
  partyId: 'cancorea_2e2427a7::12207268a8e6167b3a2994632bb41f93cf3ee7bf87ec918b2d622f60c91a4a51458e',
};

describe('cantonFingerprint', () => {
  it('reproduces the namespace of a real party from its registered key', () => {
    expect(cantonFingerprint(VADIM.publicKey)).toBe(VADIM.partyId.split('::')[1]);
    expect(cantonFingerprint(CANCORE_A.publicKey)).toBe(CANCORE_A.partyId.split('::')[1]);
  });

  it('accepts the key that owns the party', () => {
    expect(keyOwnsParty(VADIM.publicKey, VADIM.partyId)).toBe(true);
  });

  it("rejects another account's key — the BUG-318 state", () => {
    expect(keyOwnsParty(CANCORE_A.publicKey, VADIM.partyId)).toBe(false);
  });

  it('rejects a party id with no namespace half', () => {
    expect(keyOwnsParty(VADIM.publicKey, 'malformed-party')).toBe(false);
  });
});

describe('isPartyOfKey — the party of a key, whole (CAN-2249)', () => {
  const FP = VADIM.partyId.split('::')[1]!;

  it('says yes to the real party of the key, and to another hint in the same namespace', () => {
    expect(isPartyOfKey(VADIM.publicKey, VADIM.partyId)).toBe(true);
    // The hint is the account's name; the namespace is what the key decides.
    expect(isPartyOfKey(VADIM.publicKey, `grid-bot_1::${FP}`)).toBe(true);
    expect(isPartyOfKey(VADIM.publicKey.toUpperCase(), VADIM.partyId)).toBe(true);
  });

  it.each([
    ["another account's party", CANCORE_A.partyId],
    // What keyOwnsParty lets through: the right namespace with something after it.
    ['the right namespace with a third part', `vadim::${FP}::1220${'ab'.repeat(32)}`],
    ['the right namespace with a trailing separator', `vadim::${FP}::`],
    ['the namespace in upper case', `vadim::${FP.toUpperCase()}`],
    ['a line break in the hint', `vadim\nparty:mallory::${FP}`],
    ['a space in the hint', `vadim su::${FP}`],
    ['an empty hint', `::${FP}`],
    ['a hint longer than a party hint is', `${'a'.repeat(256)}::${FP}`],
    ['the namespace alone', FP],
    ['a single colon', `vadim:${FP}`],
    ['a longer namespace that starts with the fingerprint', `vadim::${FP}00`],
    ['nothing', ''],
  ])('says no to %s', (_what, partyId) => {
    expect(isPartyOfKey(VADIM.publicKey, partyId)).toBe(false);
  });

  it.each([undefined, null, 42, {}, [VADIM.partyId], { toString: () => VADIM.partyId }])(
    'says no to a value that is not a string (%p): a server answer is not trusted to be one',
    (value) => {
      expect(isPartyOfKey(VADIM.publicKey, value)).toBe(false);
    },
  );

  it('is stricter than keyOwnsParty exactly where that one is loose', () => {
    const loose = `x::${FP}::anything`;
    expect(keyOwnsParty(VADIM.publicKey, loose)).toBe(true);
    expect(isPartyOfKey(VADIM.publicKey, loose)).toBe(false);
  });
});
