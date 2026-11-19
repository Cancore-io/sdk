import { CAPTURE } from './topology.capture';
import { cantonHash, fromBase64, multiHashInput } from './hashing';
import { bytesToHex } from '../bytes';
import { TopologyRefusal, verifyPartyTopology, type PartyExpectation } from './topology';

// CAN-2414: the check runs on what a real Canton 3.4.11 participant generates,
// not on topology built by hand (see topology.capture.ts).
const { own, otherConfirmer, observer, foreignKey } = CAPTURE.cases;
const expectA: PartyExpectation = { partyId: own.partyId, publicKey: CAPTURE.keyA, participantUid: CAPTURE.localParticipant };

const refusedWith = (run: () => void, detail: RegExp): void => {
  expect(run).toThrow(TopologyRefusal);
  expect(run).toThrow(detail);
};

describe('the topology of a new party is signed only when it is the expected one (CAN-2414)', () => {
  test('a real allocation for the key, on the expected participant alone, passes', () => {
    expect(() => verifyPartyTopology(own.topologyTransactions, own.multiHash, expectA)).not.toThrow();
    expect(() => verifyPartyTopology(own.topologyTransactions, `0x${own.multiHash.toUpperCase()}`, expectA)).not.toThrow();
  });

  test('the participant matches with or without the PAR:: prefix', () => {
    expect(() => verifyPartyTopology(own.topologyTransactions, own.multiHash, { ...expectA, participantUid: `PAR::${CAPTURE.localParticipant}` })).not.toThrow();
  });

  test('no transactions to check: the leg is never signed blind', () => {
    refusedWith(() => verifyPartyTopology(undefined, own.multiHash, expectA), /no topology transactions/);
    refusedWith(() => verifyPartyTopology([], own.multiHash, expectA), /no topology transactions/);
  });

  test('a multihash of other transactions', () => {
    refusedWith(() => verifyPartyTopology(own.topologyTransactions, observer.multiHash, expectA), /not the multihash/);
  });

  test('a second confirming participant', () => {
    refusedWith(() => verifyPartyTopology(otherConfirmer.topologyTransactions, otherConfirmer.multiHash, expectA), /hosting threshold is 2/);
  });

  test('another participant observing', () => {
    refusedWith(() => verifyPartyTopology(observer.topologyTransactions, observer.multiHash, expectA), /hosted elsewhere/);
  });

  test('hosting on a participant other than the expected one', () => {
    refusedWith(() => verifyPartyTopology(own.topologyTransactions, own.multiHash, { ...expectA, participantUid: CAPTURE.otherParticipant }), /hosted elsewhere/);
  });

  test('another key’s party', () => {
    refusedWith(() => verifyPartyTopology(foreignKey.topologyTransactions, foreignKey.multiHash, expectA), /another signing key/);
    refusedWith(() => verifyPartyTopology(own.topologyTransactions, own.multiHash, { ...expectA, publicKey: CAPTURE.keyB }), /namespace of the signing key/);
  });

  test('a party other than the expected one', () => {
    refusedWith(() => verifyPartyTopology(own.topologyTransactions, own.multiHash, { ...expectA, partyId: own.partyId.replace('cancore_cap', 'someone') }), /hosting is for another party/);
  });

  // devsecops on sdk#276 (F1, F2): a field this check does not know is refused, so it and Canton
  // never read two different topologies; that includes a hosting participant still onboarding.
  test.each([
    ['an onboarding flag on the hosting participant', [0x1a, 0x00], 'participant', /still onboarding/],
    ['an unknown field on the hosting', [0x38, 0x01], 'hosting', /does not decode/],
    ['an unknown field on the transaction', [0x20, 0x01], 'transaction', /does not decode/],
    // devsecops on ab44196 (N1): only Canton's own encoding. Field 1 under wire type 5 is
    // skipped by Canton but read by protobuf-ts, so the two would parse the bytes after it apart.
    ['a known field under another wire type', [0x0d, 0x81, 0x00, 0x10, 0x01], 'transaction', /does not decode/],
    ['a field repeated', [0x10, 0x01], 'transaction', /does not decode/],
  ] as const)('a transaction carrying %s', (_name, extra, where, detail) => {
    const tx = withExtra(own.topologyTransactions[0], [...extra], where);
    const multihash = bytesToHex(cantonHash(55, multiHashInput([cantonHash(11, fromBase64(tx))])));
    refusedWith(() => verifyPartyTopology([tx], multihash, expectA), detail);
  });

  test('a versioned wrapper of another version', () => {
    const bytes = fromBase64(own.topologyTransactions[0]);
    const bumped = Uint8Array.from(bytes);
    bumped[bumped.length - 1] = 31;
    const tx = Buffer.from(bumped).toString('base64');
    const multihash = bytesToHex(cantonHash(55, multiHashInput([cantonHash(11, bumped)])));
    refusedWith(() => verifyPartyTopology([tx], multihash, expectA), /does not decode/);
  });

  test('a key that is not 32 bytes, and bytes that are not base64', () => {
    refusedWith(() => verifyPartyTopology(own.topologyTransactions, own.multiHash, { ...expectA, publicKey: CAPTURE.keyA.slice(2) }), /not a 32-byte Ed25519 key/);
    refusedWith(() => verifyPartyTopology(['not base64!'], own.multiHash, expectA), /not base64/);
  });
});

/**
 * The captured `own` transaction with `extra` appended inside one of its messages, every
 * enclosing length grown to match. Its layout (one byte of length each, as captured):
 * wrapper{1: tx{1, 2, 3: mapping{9: hosting{1, 2, 3: participant{1, 2}, 6}}}, 2: 30}.
 */
function withExtra(b64: string, extra: number[], where: 'participant' | 'hosting' | 'transaction'): string {
  const b = Array.from(fromBase64(b64));
  // Each level: the offset of its length (two bytes, < 0x4000) and of its end.
  const read = (at: number): [number, number] => (b[at]! < 0x80 ? [b[at]!, at + 1] : [(b[at]! & 0x7f) | (b[at + 1]! << 7), at + 2]);
  const levels: Array<{ lenAt: number; end: number }> = [];
  const enter = (tagAt: number): number => {
    const [len, start] = read(tagAt + 1);
    levels.push({ lenAt: tagAt + 1, end: start + len });
    return start;
  };
  const txStart = enter(0); // wrapper data
  let at = txStart;
  while (b[at] !== 0x1a) at += 2; // fields 1, 2: one-byte varints
  const mapStart = enter(at);
  const hostStart = enter(mapStart);
  if (where === 'transaction') levels.splice(1);
  let insertAt = levels[levels.length - 1]!.end;
  if (where !== 'transaction') {
    at = hostStart;
    while (b[at] !== 0x1a) at += 1 + (b[at] === 0x10 ? 1 : 1 + read(at + 1)[0] + (b[at + 1]! < 0x80 ? 0 : 1));
    if (where === 'participant') {
      enter(at);
      insertAt = levels[levels.length - 1]!.end;
    } else levels.splice(4);
  }
  b.splice(insertAt, 0, ...extra);
  for (const { lenAt } of levels) {
    const [len] = read(lenAt);
    const grown = len + extra.length;
    if ((b[lenAt]! < 0x80) !== (grown < 0x80)) throw new Error('fixture length crosses a varint byte');
    if (grown < 0x80) b[lenAt] = grown;
    else [b[lenAt], b[lenAt + 1]] = [(grown & 0x7f) | 0x80, grown >> 7];
  }
  return Buffer.from(b).toString('base64');
}
