import { CAPTURE } from './topology.capture';
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

  test('a key that is not 32 bytes, and bytes that are not base64', () => {
    refusedWith(() => verifyPartyTopology(own.topologyTransactions, own.multiHash, { ...expectA, publicKey: CAPTURE.keyA.slice(2) }), /not a 32-byte Ed25519 key/);
    refusedWith(() => verifyPartyTopology(['not base64!'], own.multiHash, expectA), /not base64/);
  });
});
