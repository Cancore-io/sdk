#!/usr/bin/env node
// Golden vectors of filler-gateway → filler `settle.attestations` (protocol
// §3.5, §3.6, §10 D-N), generated with ethers — an encoder and a signer this
// package does not ship. Deterministic: every key is
// keccak256("cancore:test-kit:<role>:v1") (TEST ONLY, publicly known, never
// fund), every input a literal below; a re-run rewrites a byte-identical file.
// Run after gen-protocol-vectors.mjs, before gen-protocol-docs.mjs.
//
//   node packages/contracts/scripts/gen-settle-attestations.mjs
//
// FillProof is the router's struct as synced from evm-contracts
// (spec/typed-data/FillProof.json), never a copy: when variant A (protocol
// §3.3: fillerId, repayTo) replaces it (CAN-2139, CAN-2140), re-run this
// script after the sync and give the proofs below the new fields.
import { keccak256, SigningKey, Signature, toUtf8Bytes, TypedDataEncoder } from 'ethers';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => JSON.parse(readFileSync(join(pkg, 'spec', ...p), 'utf8'));

const FILL_PROOF_SPEC = read('typed-data', 'FillProof.json');
const FILL_PROOF = FILL_PROOF_SPEC.types.FillProof;
const GATEWAY_MESSAGE = [{ name: 'bodyHash', type: 'bytes32' }];
const PROTOCOL = { name: 'CancoreFillerProtocol', version: '1' };
const ENVELOPE = ['type', 'fillerId', 'sentAt', 'sig', 're'];
const SPKI_PREFIX = '3056301006072a8648ce3d020106052b8104000a034200';

const utf8Hash = (s) => keccak256(toUtf8Bytes(s));
/** RFC 8785 for the value subset of the protocol: default sort is by UTF-16 code units. */
const jcs = (v) =>
  v === null || typeof v !== 'object'
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? `[${v.map(jcs).join(',')}]`
      : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${jcs(v[k])}`).join(',')}}`;

/** TEST ONLY: keccak256("cancore:test-kit:<role>:v1"), the derivation of @cancore/test-kit keys. */
const testKey = (role) => new SigningKey(utf8Hash(`cancore:test-kit:${role}:v1`));
const addressOf = (key) => `0x${keccak256(`0x${key.publicKey.slice(4)}`).slice(26)}`;
const GATEWAY = testKey('gateway');
const ATTESTORS = ['attestor-a', 'attestor-b', 'attestor-c']
  .map((role) => ({ role, key: testKey(role) }))
  .map((a) => ({ ...a, address: addressOf(a.key) }))
  .sort((x, y) => (x.address < y.address ? -1 : 1));
const OUTSIDER_KEY = testKey('attestor-outsider');
const OUTSIDER = { role: 'attestor-outsider', key: OUTSIDER_KEY, address: addressOf(OUTSIDER_KEY) };

/** Minimal positive DER INTEGER content of a 32-byte big-endian value (Intent.FillProofVerify.derInt). */
const derInt = (hex) => {
  const t = hex.replace(/^(00)+/, '');
  if (t === '') return '00';
  return parseInt(t[0], 16) >= 8 ? `00${t}` : t;
};
const lenByte = (hex) => (hex.length / 2).toString(16).padStart(2, '0');
/** r ‖ s ‖ v → minimal DER (v dropped), as SwapIntent_SettleWithProof takes it. */
const derFromRsv = (rsv) => {
  const r = derInt(rsv.slice(2, 66));
  const s = derInt(rsv.slice(66, 130));
  const body = `02${lenByte(r)}${r}02${lenByte(s)}${s}`;
  return `0x30${lenByte(body)}${body}`;
};
const spkiOf = (key) => `0x${SPKI_PREFIX}${key.publicKey.slice(2)}`;

const sign = (key, digest) => Signature.from(key.sign(digest)).serialized.toLowerCase();
const proofDigest = (domain, proof) => TypedDataEncoder.hash(domain, { FillProof: FILL_PROOF }, proof);
const evmEntry = (a, digest) => ({ signer: a.address, signature: sign(a.key, digest) });
const cantonEntry = (a, digest) => ({ signer: a.address, pubKey: spkiOf(a.key), signature: derFromRsv(sign(a.key, digest)) });
const bySigner = (x, y) => (x.signer < y.signer ? -1 : 1);

/** The payload both channels carry: the frame without its envelope. */
const payloadOf = (frame) => Object.fromEntries(Object.entries(frame).filter(([k]) => !ENVELOPE.includes(k)));
/** Sign an S→F frame with the TEST gateway key: GatewayMessage{keccak256(JCS(frame without sig))}. */
function signFrame(unsigned) {
  const bodyHash = utf8Hash(jcs(unsigned));
  const digest = TypedDataEncoder.hash(PROTOCOL, { GatewayMessage: GATEWAY_MESSAGE }, { bodyHash });
  return { ...unsigned, sig: sign(GATEWAY, digest) };
}

const orderVectors = read('typed-data', 'Order.json').vectors;
const cantonOrder = orderVectors[0];
const evmOrder = orderVectors[1];
const EVM_DOMAIN = { name: 'CancoreRouter', version: '1', chainId: evmOrder.chainId, verifyingContract: evmOrder.verifyingContract };
const CANTON_DOMAIN = { name: 'CancoreRouter', version: '1', chainId: cantonOrder.chainId, verifyingContract: cantonOrder.verifyingContract };

function caseOf({ note, sourceChainId, domain, order, proof, threshold, signers, entry, refundAfter, sentAt, fillerId }) {
  const digest = proofDigest(domain, proof);
  const signatures = signers.map((a) => entry(a, digest));
  const unsigned = {
    type: 'settle.attestations', fillerId, sentAt: sentAt.ws, orderHash: proof.orderHash, attempt: proof.attempt, sourceChainId, proof, signatures,
    setId: proof.setId, threshold, refundAfter,
  };
  const ws = signFrame(unsigned);
  const rest = signFrame({ ...unsigned, sentAt: sentAt.rest });
  const payload = payloadOf(ws);
  return {
    note,
    domain: { chainId: domain.chainId, verifyingContract: domain.verifyingContract },
    order,
    digest,
    set: { setId: proof.setId, threshold, members: ATTESTORS.map((a) => a.address) },
    ...(entry === cantonEntry ? { rsv: signers.map((a) => sign(a.key, digest)) } : {}),
    ws,
    rest,
    payloadJcs: jcs(payload),
    payloadHash: utf8Hash(jcs(payload)),
  };
}

const ACME_PAYOUT = '0x742d35cc6634c0532925a3b844bc454e4438f44e';
const RESERVE_PAYOUT = addressOf(testKey('reserve-filler'));
const evmProof = {
  kind: 1,
  orderHash: evmOrder.digest,
  destination: evmOrder.message.destination,
  fillRef: utf8Hash('cancore:test-kit:fixture-fill-tx'),
  recipient: evmOrder.message.recipient,
  outputAsset: evmOrder.message.outputAsset,
  amountDelivered: evmOrder.message.minReceived,
  filledAt: '1790000100',
  filler: ACME_PAYOUT,
  attempt: 0,
  setId: 1,
};
const evm = caseOf({
  note: 'EVM source (Sepolia, the fixture order of spec/typed-data/Order.json): 2 of a 3-member set, k = 2; the signature values in this order are the sigs of settle(order, proof, sigs)',
  sourceChainId: `eip155:${evmOrder.chainId}`,
  domain: EVM_DOMAIN,
  order: evmOrder.message,
  proof: evmProof,
  threshold: 2,
  signers: ATTESTORS.slice(0, 2),
  entry: evmEntry,
  refundAfter: '1790002400',
  sentAt: { ws: 1790000160000, rest: 1790000175000 },
  fillerId: 'acme-markets',
});
const cantonProof = {
  kind: 1,
  orderHash: cantonOrder.digest,
  destination: cantonOrder.message.destination,
  fillRef: utf8Hash('cancore:test-kit:canton-source-fill-tx'),
  recipient: cantonOrder.message.recipient,
  outputAsset: cantonOrder.message.outputAsset,
  amountDelivered: cantonOrder.message.minReceived,
  filledAt: '1789999700',
  filler: RESERVE_PAYOUT,
  attempt: 1,
  setId: 3,
};
const canton = caseOf({
  note: 'Canton source (spec/vectors/canton-order.json, mainnet origin id): 3 of 3, k = 2; each entry is a SigEntry of SwapIntent_SettleWithProof (pubKey, signature, without 0x on the ledger); filler is the payout address named in the owner-signed fillerAddresses; rsv: the 65-byte form of the same signatures, for cross-checks',
  sourceChainId: 'canton:mainnet',
  domain: CANTON_DOMAIN,
  order: cantonOrder.message,
  proof: cantonProof,
  threshold: 2,
  signers: ATTESTORS,
  entry: cantonEntry,
  refundAfter: '1790001800',
  sentAt: { ws: 1789999760000, rest: 1789999790000 },
  fillerId: 'cancore-reserve',
});

// Schema-valid payloads a receiver MUST refuse (T-7): each breaks one rule the schema cannot express.
const evmPayload = payloadOf(evm.ws);
const [a0, a1] = ATTESTORS;
const invalid = [
  { note: 'fewer signatures than threshold', rule: 'threshold', payload: { ...evmPayload, signatures: [evmEntry(a0, evm.digest)] } },
  { note: 'signers not strictly ascending', rule: 'ascending', payload: { ...evmPayload, signatures: [evmEntry(a1, evm.digest), evmEntry(a0, evm.digest)] } },
  { note: 'one signer twice', rule: 'ascending', payload: { ...evmPayload, signatures: [evmEntry(a0, evm.digest), evmEntry(a0, evm.digest)] } },
  { note: 'attempt differs from proof.attempt', rule: 'attempt', payload: { ...evmPayload, attempt: 1 } },
  { note: 'setId differs from proof.setId', rule: 'setId', payload: { ...evmPayload, setId: 2 } },
  { note: 'orderHash differs from proof.orderHash', rule: 'orderHash', payload: { ...evmPayload, orderHash: cantonOrder.digest } },
  {
    note: `a valid signature by ${OUTSIDER.address}, which is not a member of set 1`,
    rule: 'member',
    payload: { ...evmPayload, signatures: [evmEntry(a0, evm.digest), evmEntry(OUTSIDER, evm.digest)].sort(bySigner) },
  },
  {
    note: 'amountDelivered raised after signing: the signatures no longer recover to their signers',
    rule: 'signature',
    payload: { ...evmPayload, proof: { ...evmProof, amountDelivered: '999000001' } },
  },
];

writeFileSync(
  join(pkg, 'spec', 'protocol', 'vectors', 'settle-attestations.json'),
  `${JSON.stringify(
    {
      $comment:
        'settle.attestations (protocol §3.5, §3.6, §10 D-N). Each case: the FillProof digest in the source-router domain; the frame as pushed over WebSocket (ws) and as returned by GET /v1/filler/attestations/{orderHash} (rest), both signed by the TEST gateway key keccak256("cancore:test-kit:gateway:v1") with different sentAt; and the payload both carry (the frame without type, fillerId, sentAt, sig, re), byte-identical (payloadJcs). Attestor keys are keccak256("cancore:test-kit:attestor-{a,b,c}:v1"), TEST ONLY. FillProof is the struct of the source router (spec/typed-data/FillProof.json). invalid: schema-valid payloads a filler MUST refuse (T-7); rule names the check that fails (threshold, ascending, attempt, setId, orderHash: settleAttestationsErrors; member, signature: the own check of the filler against the set and its secp256k1 recovery). Generated by scripts/gen-settle-attestations.mjs with ethers.',
      fillProofTypeString: FILL_PROOF_SPEC.typeString,
      gateway: addressOf(GATEWAY),
      attestors: ATTESTORS.map((a) => ({ role: a.role, address: a.address, pubKey: spkiOf(a.key) })),
      outsider: OUTSIDER.address,
      cases: { evm, canton },
      invalid,
    },
    null,
    2,
  )}\n`,
);
console.log(`settle.attestations vectors written: evm digest ${evm.digest}, canton digest ${canton.digest}`);
