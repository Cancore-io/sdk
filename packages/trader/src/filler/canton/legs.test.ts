import type { CantonLegTopology, CantonLegTransaction, Hex } from '@cancore/contracts';
import {
  CryptoKeyFormat,
  Enums_ParticipantPermission,
  Enums_TopologyChangeOp,
  PreparedTransaction,
  SigningKeyScheme,
  SigningKeySpec,
  type SigningPublicKey,
  TopologyTransaction,
} from '@canton-network/core-ledger-proto';
import { hashPreparedTransaction } from '@canton-network/core-tx-visualizer';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  CantonRefusal,
  cantonFingerprint,
  decodeTopology,
  HASHING_SCHEME_V2,
  legKind,
  verifyTopologyLeg,
  verifyTransactionLeg,
} from './legs';

// A key generated for the test only; it never signs anything outside it.
const NODE_KEY = bytesToHex(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()));
const OTHER_KEY = bytesToHex(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()));
const PARTICIPANT = 'PAR::cancore-participant::1220aaaa';
const party = (key = NODE_KEY) => `cancore-dev-1::${cantonFingerprint(key)}`;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

const int32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n, false);
  return b;
};
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
/** Canton's hash with purpose, computed here independently of the library under use. */
const cantonHash = (purpose: number, bytes: Uint8Array) => cat(new Uint8Array([0x12, 0x20]), sha256(cat(int32(purpose), bytes)));
/** MultiTopologyTransaction: purpose 55 over int32(n) ‖ (int32(len) ‖ hash) for the hashes sorted. */
const multiHash = (txs: Uint8Array[]) => {
  const hashes = txs.map((t) => cantonHash(11, t)).sort((a, b) => bytesToHex(a).localeCompare(bytesToHex(b)));
  return cantonHash(55, cat(int32(hashes.length), ...hashes.flatMap((h) => [int32(h.length), h])));
};

const signingKey = (hex: string, der = false): SigningPublicKey => ({
  format: der ? CryptoKeyFormat.DER : CryptoKeyFormat.RAW,
  publicKey: hexToBytes(der ? `302a300506032b6570032100${hex}` : hex),
  scheme: SigningKeyScheme.ED25519,
  usage: [],
  keySpec: SigningKeySpec.EC_CURVE25519,
});

type Mapping = NonNullable<NonNullable<TopologyTransaction['mapping']>['mapping']>;
const tx = (mapping: Mapping, operation = Enums_TopologyChangeOp.ADD_REPLACE) =>
  TopologyTransaction.toBinary(TopologyTransaction.create({ operation, serial: 1, mapping: { mapping } }));

/** The three transactions of an honest allocation; `over` replaces parts of them. */
function allocation(over: { ns?: Partial<{ namespace: string; key: string }>; keys?: Partial<{ party: string; threshold: number; keys: string[] }>; hosting?: Partial<{ party: string; threshold: number; participants: Array<{ uid: string; permission: Enums_ParticipantPermission }> }> } = {}) {
  return [
    tx({
      oneofKind: 'namespaceDelegation',
      namespaceDelegation: {
        namespace: over.ns?.namespace ?? cantonFingerprint(NODE_KEY),
        targetKey: signingKey(over.ns?.key ?? NODE_KEY, true),
        isRootDelegation: true,
        restriction: { oneofKind: undefined },
      } as never,
    }),
    tx({
      oneofKind: 'partyToKeyMapping',
      partyToKeyMapping: { party: over.keys?.party ?? party(), threshold: over.keys?.threshold ?? 1, signingKeys: (over.keys?.keys ?? [NODE_KEY]).map((k) => signingKey(k)) },
    }),
    tx({
      oneofKind: 'partyToParticipant',
      partyToParticipant: {
        party: over.hosting?.party ?? party(),
        threshold: over.hosting?.threshold ?? 1,
        participants: (over.hosting?.participants ?? [{ uid: PARTICIPANT, permission: Enums_ParticipantPermission.CONFIRMATION }]).map((p) => ({ participantUid: p.uid, permission: p.permission })),
      } as never,
    }),
  ];
}

const topologyLeg = (txs: Uint8Array[], hash = multiHash(txs)): CantonLegTopology => ({
  legId: 'topology-0',
  kind: 'topology',
  hash: `0x${bytesToHex(hash)}` as Hex,
  topologyTransactions: txs.map(b64),
});
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
  async function leg(over: Partial<CantonLegTransaction> = {}): Promise<CantonLegTransaction> {
    const message = PreparedTransaction.create({
      transaction: { version: '2.1', roots: [], nodes: [], nodeSeeds: [] },
      metadata: {
        submitterInfo: { actAs: [party()], commandId: 'legs-test' },
        synchronizerId: 'global-domain::1220dso',
        mediatorGroup: 0,
        transactionUuid: '00000000-0000-4000-8000-000000000000',
        preparationTime: 1000000000000000n,
        inputContracts: [],
        globalKeyMapping: [],
      },
    });
    const preparedTransaction = b64(PreparedTransaction.toBinary(message));
    const hash = `0x${await hashPreparedTransaction(preparedTransaction, 'hex')}` as Hex;
    return { legId: 'tx-0', kind: 'transaction', hash, preparedTransaction, hashingSchemeVersion: HASHING_SCHEME_V2, ...over };
  }

  test('the hash is recomputed and the decoded transaction returned', async () => {
    const decoded = await verifyTransactionLeg(await leg());
    expect(decoded.metadata?.submitterInfo?.commandId).toBe('legs-test');
  });

  test('a hash the transaction does not have, a scheme other than V2 or none, and undecodable bytes are refused', async () => {
    await refusedWith(verifyTransactionLeg(await leg({ hash: `0x${'00'.repeat(32)}` })), /not the hash of the prepared transaction/);
    await refusedWith(verifyTransactionLeg(await leg({ hashingSchemeVersion: 'HASHING_SCHEME_VERSION_V1' })), /hashing scheme/);
    await refusedWith(verifyTransactionLeg(await leg({ hashingSchemeVersion: undefined as never })), /hashing scheme/);
    await refusedWith(verifyTransactionLeg(await leg({ preparedTransaction: '' })), /no prepared transaction/);
    await refusedWith(verifyTransactionLeg(await leg({ preparedTransaction: b64(new Uint8Array([0xff, 0xff, 0xff])) })), /does not decode/);
  });

  test('the leg kind is closed', () => {
    expect(legKind({ legId: 'a', kind: 'transaction' } as never)).toBe('transaction');
    expect(legKind({ legId: 'b', kind: 'topology' } as never)).toBe('topology');
    expect(() => legKind({ legId: 'c', kind: 'raw-hash' } as never)).toThrow(/unknown leg kind raw-hash/);
  });
});
