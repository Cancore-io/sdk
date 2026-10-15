/** Test fixtures of the Canton leg checks: an honest party allocation and a transaction leg, and the parts to break them. */
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
import { cantonFingerprint, HASHING_SCHEME_V2 } from './legs';

// A key generated for the test only; it never signs anything outside it.
export const NODE_PRIVATE_KEY = ed25519.utils.randomPrivateKey();
export const NODE_KEY = bytesToHex(ed25519.getPublicKey(NODE_PRIVATE_KEY));
export const OTHER_KEY = bytesToHex(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()));
export const PARTICIPANT = 'PAR::cancore-participant::1220aaaa';
export const party = (key = NODE_KEY) => `cancore-dev-1::${cantonFingerprint(key)}`;
export const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

export const int32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n, false);
  return b;
};
export const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
/** Canton's hash with purpose, computed here independently of the library under use. */
export const cantonHash = (purpose: number, bytes: Uint8Array) => cat(new Uint8Array([0x12, 0x20]), sha256(cat(int32(purpose), bytes)));
/** MultiTopologyTransaction: purpose 55 over int32(n) ‖ (int32(len) ‖ hash) for the hashes sorted. */
export const multiHash = (txs: Uint8Array[]) => {
  const hashes = txs.map((t) => cantonHash(11, t)).sort((a, b) => bytesToHex(a).localeCompare(bytesToHex(b)));
  return cantonHash(55, cat(int32(hashes.length), ...hashes.flatMap((h) => [int32(h.length), h])));
};

export const signingKey = (hex: string, der = false): SigningPublicKey => ({
  format: der ? CryptoKeyFormat.DER : CryptoKeyFormat.RAW,
  publicKey: hexToBytes(der ? `302a300506032b6570032100${hex}` : hex),
  scheme: SigningKeyScheme.ED25519,
  usage: [],
  keySpec: SigningKeySpec.EC_CURVE25519,
});

export type Mapping = NonNullable<NonNullable<TopologyTransaction['mapping']>['mapping']>;
export const tx = (mapping: Mapping, operation = Enums_TopologyChangeOp.ADD_REPLACE, serial = 1) =>
  TopologyTransaction.toBinary(TopologyTransaction.create({ operation, serial, mapping: { mapping } }));

/** The three transactions of an honest allocation; `over` replaces parts of them. */
export function allocation(over: { ns?: Partial<{ namespace: string; key: string }>; keys?: Partial<{ party: string; threshold: number; keys: string[] }>; hosting?: Partial<{ party: string; threshold: number; participants: Array<{ uid: string; permission: Enums_ParticipantPermission }> }> } = {}) {
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

export const topologyLeg = (txs: Uint8Array[], hash = multiHash(txs)): CantonLegTopology => ({
  legId: 'topology-0',
  kind: 'topology',
  hash: `0x${bytesToHex(hash)}` as Hex,
  topologyTransactions: txs.map(b64),
});

export async function transactionLeg(over: Partial<CantonLegTransaction> = {}): Promise<CantonLegTransaction> {
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
