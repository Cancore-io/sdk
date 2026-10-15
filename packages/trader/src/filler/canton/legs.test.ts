import type { Hex } from '@cancore/contracts';
import { Enums_ParticipantPermission, Enums_TopologyChangeOp, TopologyTransaction } from '@canton-network/core-ledger-proto';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  allocation,
  b64,
  cantonHash,
  cat,
  multiHash,
  NODE_KEY,
  OTHER_KEY,
  PARTICIPANT,
  party,
  topologyLeg,
  transactionLeg,
  tx,
} from './fixtures';
import { CantonRefusal, cantonFingerprint, decodeTopology, legKind, verifyTopologyLeg, verifyTransactionLeg } from './legs';

const expect_ = { partyId: party(), publicKey: `0x${NODE_KEY}` as Hex, participantUid: PARTICIPANT };
const refusedWith = async (p: Promise<unknown>, detail: RegExp) => {
  await expect(p).rejects.toBeInstanceOf(CantonRefusal);
  await expect(p).rejects.toThrow(detail);
};

describe('the fingerprint and the multihash are Canton’s', () => {
  test('fingerprint = 1220 ‖ sha256(int32BE(12) ‖ key)', () => {
    expect(cantonFingerprint(NODE_KEY)).toBe(bytesToHex(cantonHash(12, hexToBytes(NODE_KEY))));
    expect(() => cantonFingerprint('00')).toThrow(TypeError);
  });

  test('an honest allocation passes; its hash is the independently computed multihash', async () => {
    await expect(verifyTopologyLeg(topologyLeg(allocation()), expect_)).resolves.toBeUndefined();
  });

  test('a versioned wrapper (UntypedVersionedMessage) around each transaction decodes the same', () => {
    const [raw] = allocation();
    const varint: number[] = [];
    for (let n = raw!.length; ; n >>>= 7) {
      if (n < 0x80) {
        varint.push(n);
        break;
      }
      varint.push((n & 0x7f) | 0x80);
    }
    const wrapped = cat(new Uint8Array([0x0a, ...varint]), raw!, new Uint8Array([0x10, 0x1e]));
    expect(decodeTopology(wrapped)).toEqual(decodeTopology(raw!));
    // Only the version field may follow the data, once; nothing after it.
    const head = cat(new Uint8Array([0x0a, ...varint]), raw!);
    expect(decodeTopology(head)).toEqual(decodeTopology(raw!));
    expect(() => decodeTopology(cat(head, new Uint8Array([0x18, 0x01])))).toThrow(/unexpected field/);
    expect(() => decodeTopology(cat(head, new Uint8Array([0x10, 0x1e, 0x00])))).toThrow(/unexpected bytes/);
    expect(() => decodeTopology(cat(new Uint8Array([0x0a, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]), raw!))).toThrow(/varint/);
  });
});

describe('a topology leg is refused, never signed, when', () => {
  test('its hash is not the multihash of its transactions', async () => {
    const txs = allocation();
    await refusedWith(verifyTopologyLeg(topologyLeg(txs, multiHash(txs.slice(1))), expect_), /not the multihash/);
  });

  test('the party is not in the namespace of the node key', async () => {
    await refusedWith(verifyTopologyLeg(topologyLeg(allocation()), { ...expect_, partyId: party(OTHER_KEY) }), /namespace of the node key/);
  });

  test.each([
    ['the namespace is another key’s', { ns: { namespace: cantonFingerprint(OTHER_KEY) } }, /namespace is not the fingerprint/],
    ['the namespace delegates to another key', { ns: { key: OTHER_KEY } }, /delegates to another key/],
    ['a second signing key', { keys: { keys: [NODE_KEY, OTHER_KEY] } }, /another signing key/],
    ['another key alone', { keys: { keys: [OTHER_KEY] } }, /another signing key/],
    ['a key threshold of 2', { keys: { threshold: 2 } }, /key threshold is 2/],
    ['the keys of another party', { keys: { party: `x::${cantonFingerprint(NODE_KEY)}` } }, /another party/],
    ['a second hosting participant', { hosting: { participants: [{ uid: PARTICIPANT, permission: Enums_ParticipantPermission.CONFIRMATION }, { uid: 'PAR::evil::1220bb', permission: Enums_ParticipantPermission.CONFIRMATION }] } }, /hosted elsewhere/],
    ['another participant', { hosting: { participants: [{ uid: 'PAR::evil::1220bb', permission: Enums_ParticipantPermission.CONFIRMATION }] } }, /hosted elsewhere/],
    ['Submission permission', { hosting: { participants: [{ uid: PARTICIPANT, permission: Enums_ParticipantPermission.SUBMISSION }] } }, /not Confirmation/],
    ['a hosting threshold of 2', { hosting: { threshold: 2 } }, /hosting threshold is 2/],
  ])('%s', async (_name, over, detail) => {
    await refusedWith(verifyTopologyLeg(topologyLeg(allocation(over as never)), expect_), detail);
  });

  test('the participant matches with or without the PAR:: prefix on either side', async () => {
    const bare = PARTICIPANT.replace(/^PAR::/, '');
    await expect(verifyTopologyLeg(topologyLeg(allocation()), { ...expect_, participantUid: bare })).resolves.toBeUndefined();
    const hostedBare = allocation({ hosting: { participants: [{ uid: bare, permission: Enums_ParticipantPermission.CONFIRMATION }] } });
    await expect(verifyTopologyLeg(topologyLeg(hostedBare), expect_)).resolves.toBeUndefined();
  });

  test('a mapping above serial 1: it would re-host or re-key a party that exists', async () => {
    const [ns, keys, hosting] = allocation();
    const again = tx(TopologyTransaction.fromBinary(hosting!).mapping!.mapping, Enums_TopologyChangeOp.ADD_REPLACE, 2);
    await refusedWith(verifyTopologyLeg(topologyLeg([ns!, keys!, again]), expect_), /serial 2, not 1/);
  });

  test('a mapping is missing, repeated, removed or of another kind', async () => {
    const [ns, keys, hosting] = allocation();
    await refusedWith(verifyTopologyLeg(topologyLeg([ns!, keys!]), expect_), /no partyToParticipant/);
    await refusedWith(verifyTopologyLeg(topologyLeg([ns!, keys!, hosting!, keys!]), expect_), /two partyToKeyMapping/);
    const removed = tx(TopologyTransaction.fromBinary(keys!).mapping!.mapping, Enums_TopologyChangeOp.REMOVE);
    await refusedWith(verifyTopologyLeg(topologyLeg([ns!, removed, hosting!]), expect_), /not ADD_REPLACE/);
    const other = tx({ oneofKind: 'synchronizerTrustCertificate', synchronizerTrustCertificate: { participantUid: PARTICIPANT, synchronizerId: 's' } } as never);
    await refusedWith(verifyTopologyLeg(topologyLeg([ns!, keys!, hosting!, other]), expect_), /not part of a party allocation/);
    await refusedWith(verifyTopologyLeg(topologyLeg([]), expect_), /no topology transactions/);
  });
});

describe('transaction legs', () => {
  test('the hash is recomputed and the decoded transaction returned', async () => {
    const decoded = await verifyTransactionLeg(await transactionLeg());
    expect(decoded.commandId).toBe('legs-test');
    expect(decoded.actAs).toEqual([party()]);
  });

  test('a hash the transaction does not have, a scheme other than V2 or none, and undecodable bytes are refused', async () => {
    await refusedWith(verifyTransactionLeg(await transactionLeg({ hash: `0x${'00'.repeat(32)}` })), /not the hash of the prepared transaction/);
    await refusedWith(verifyTransactionLeg(await transactionLeg({ hashingSchemeVersion: 'HASHING_SCHEME_VERSION_V1' })), /hashing scheme/);
    await refusedWith(verifyTransactionLeg(await transactionLeg({ hashingSchemeVersion: undefined as never })), /hashing scheme/);
    await refusedWith(verifyTransactionLeg(await transactionLeg({ preparedTransaction: '' })), /no prepared transaction/);
    await refusedWith(verifyTransactionLeg(await transactionLeg({ preparedTransaction: b64(new Uint8Array([0xff, 0xff, 0xff])) })), /does not decode/);
  });

  test('the leg kind is closed', () => {
    expect(legKind({ legId: 'a', kind: 'transaction' } as never)).toBe('transaction');
    expect(legKind({ legId: 'b', kind: 'topology' } as never)).toBe('topology');
    expect(() => legKind({ legId: 'c', kind: 'raw-hash' } as never)).toThrow(/unknown leg kind raw-hash/);
  });
});
