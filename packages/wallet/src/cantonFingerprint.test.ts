import { cantonFingerprint, keyOwnsParty } from './cantonFingerprint';

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
