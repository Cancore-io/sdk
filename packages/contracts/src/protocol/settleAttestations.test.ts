import Ajv2020 from 'ajv/dist/2020';
import { keccak256, recoverAddress, Signature, SigningKey } from 'ethers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FILL_PROOF_TYPES, FILL_PROOF_TYPE_STRING, fillProofDomain } from '../eip712';
import { gatewayBodyHash, hashTypedData, jcs } from './hash';
import { ERROR_HTTP_STATUS } from './messages';
import { messageSchemaRef, MESSAGE_DIRECTIONS, PROTOCOL_SCHEMAS, REST_ENDPOINTS, SCHEMA_VOCABULARY } from './schemas';
import {
  cantonSigEntries, isCantonSource, settleAttestationsErrors, settleAttestationsPayload, settleAttestationsPayloadHash, settleSigs,
  type SettleAttestations, type SettleAttestationsPayload,
} from './settleAttestations';
import { FILLER_PROTOCOL_DOMAIN, GATEWAY_MESSAGE_TYPES, type Hex } from './typedData';

type Case = {
  note: string;
  domain: { chainId: string; verifyingContract: Hex };
  digest: Hex;
  set: { setId: number; threshold: number; members: Hex[] };
  rsv?: Hex[];
  ws: SettleAttestations;
  rest: SettleAttestations;
  payloadJcs: string;
  payloadHash: Hex;
};
const vectors = JSON.parse(readFileSync(join(__dirname, '..', '..', 'spec', 'protocol', 'vectors', 'settle-attestations.json'), 'utf8')) as {
  fillProofTypeString: string;
  gateway: Hex;
  attestors: { role: string; address: Hex; pubKey: Hex }[];
  outsider: Hex;
  cases: { evm: Case; canton: Case };
  invalid: { note: string; rule: string; payload: SettleAttestationsPayload }[];
};
const { evm, canton } = vectors.cases;
const CASES = [['evm', evm], ['canton', canton]] as const;

const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addVocabulary([...SCHEMA_VOCABULARY]);
for (const s of Object.values(PROTOCOL_SCHEMAS)) ajv.addSchema(s as object);
const errorsOf = (frame: unknown) => (ajv.validate(messageSchemaRef('settle.attestations', 'S2F'), frame) ? [] : ajv.errors!);
const clone = <T>(v: T): T => structuredClone(v);

const proofDigest = (c: Case, proof = c.ws.proof) =>
  hashTypedData({ domain: fillProofDomain(BigInt(c.domain.chainId), c.domain.verifyingContract), types: FILL_PROOF_TYPES, primaryType: 'FillProof', message: { ...proof } });

/** Minimal DER → 64-byte r ‖ s, refusing a non-minimal or malformed encoding (what Daml's verifier aborts on). */
function rsFromMinimalDer(der: Hex): { r: string; s: string } {
  const b = Buffer.from(der.slice(2), 'hex');
  expect(b[0]).toBe(0x30);
  expect(b[1]).toBe(b.length - 2);
  let i = 2;
  const int = () => {
    expect(b[i]).toBe(0x02);
    const len = b[i + 1]!;
    const v = b.subarray(i + 2, i + 2 + len);
    i += 2 + len;
    expect(len).toBeGreaterThan(0);
    if (len > 1) expect(v[0] === 0 && v[1]! < 0x80).toBe(false); // no superfluous leading zero
    expect(v[0]! & 0x80).toBe(0); // positive
    return v.toString('hex').replace(/^00/, '').padStart(64, '0');
  };
  const r = int();
  const s = int();
  expect(i).toBe(b.length);
  return { r, s };
}
const addressOfSpki = (spki: Hex) => `0x${keccak256(`0x${spki.slice(2 + 46 + 2)}`).slice(26)}`;

describe('schema', () => {
  test('one more S→F frame type, addressed, timed and signed', () => {
    expect(MESSAGE_DIRECTIONS['settle.attestations']).toBe('S2F');
  });
  test('proof is the FillProof the source router hashes, field for field, and the vectors were generated from it', () => {
    const fillProof = (PROTOCOL_SCHEMAS.messages as { $defs: Record<string, { required: string[]; properties: object }> }).$defs.fillProof!;
    const names = FILL_PROOF_TYPES.FillProof.map((f) => f.name);
    expect(fillProof.required).toEqual(names);
    expect(Object.keys(fillProof.properties)).toEqual(names);
    expect(vectors.fillProofTypeString).toBe(FILL_PROOF_TYPE_STRING);
  });
  test.each(CASES)('%s: the pushed frame and the REST body validate', (_, c) => {
    expect(errorsOf(c.ws)).toEqual([]);
    expect(errorsOf(c.rest)).toEqual([]);
  });
  test('the entry form follows sourceChainId: an EVM entry on a Canton source is refused, and the other way round', () => {
    expect(errorsOf({ ...clone(canton.ws), signatures: evm.ws.signatures }).length).toBeGreaterThan(0);
    expect(errorsOf({ ...clone(evm.ws), signatures: canton.ws.signatures }).length).toBeGreaterThan(0);
  });
  test.each([
    ['signatures', []],
    ['threshold', 0],
    ['attempt', '0'],
    ['refundAfter', 1790002400],
    ['sourceChainId', 'eip155:01'],
    ['orderHash', `0x${'AB'.repeat(32)}`],
  ])('%s = %j is refused', (field, bad) => {
    const errors = errorsOf({ ...clone(evm.ws), [field]: bad });
    expect(errors.map((e) => e.instancePath)).toContain(`/${field}`);
  });
  test.each(['fillerId', 'repayTo', 'amountDelivered', 'setId'])('proof without %s is refused', (field) => {
    const frame = clone(evm.ws);
    delete (frame.proof as unknown as Record<string, unknown>)[field];
    expect(errorsOf(frame).length).toBeGreaterThan(0);
  });
  test.each([
    ['pubKey', `0x${'00'.repeat(88)}`],
    ['signature', canton.rsv![0]!],
    ['signature', '0x3006020101020101'.slice(0, 10)],
  ])('Canton entry: %s = %j is refused', (field, bad) => {
    const frame = clone(canton.ws);
    (frame.signatures[0] as unknown as Record<string, unknown>)[field] = bad;
    expect(errorsOf(frame).length).toBeGreaterThan(0);
  });
  test('envelope: no sig, no fillerId or sentAt in seconds is refused; an unknown field is ignored (V-2)', () => {
    for (const [k, v] of [['sig', undefined], ['fillerId', undefined], ['sentAt', 1790000160]] as const) expect(errorsOf({ ...clone(evm.ws), [k]: v }).length).toBeGreaterThan(0);
    expect(errorsOf({ ...clone(evm.ws), relayHint: 'x' })).toEqual([]);
  });
  test('REST: GET /v1/filler/attestations/{orderHash} answers the frame; ATTESTATIONS_NOT_READY is a 404', () => {
    const e = REST_ENDPOINTS.find((x) => x.path === '/v1/filler/attestations/{orderHash}');
    expect(e).toEqual({ method: 'GET', path: '/v1/filler/attestations/{orderHash}', auth: 'bearer', response: 'messages.schema.json#/$defs/settle.attestations' });
    expect(ERROR_HTTP_STATUS.ATTESTATIONS_NOT_READY).toBe(404);
    expect(ERROR_HTTP_STATUS.UNKNOWN_TICKET).toBe(404);
  });
});

describe.each(CASES)('%s vector', (_, c) => {
  test('WebSocket frame and REST body carry the same payload, byte for byte', () => {
    expect(c.ws.sentAt).not.toBe(c.rest.sentAt);
    expect(jcs(settleAttestationsPayload(c.ws))).toBe(c.payloadJcs);
    expect(jcs(settleAttestationsPayload(c.rest))).toBe(c.payloadJcs);
    expect(settleAttestationsPayloadHash(c.ws)).toBe(c.payloadHash);
    expect(settleAttestationsPayloadHash(c.rest)).toBe(c.payloadHash);
  });
  test('both are signed by the gateway (GatewayMessage over the JCS body)', () => {
    for (const frame of [c.ws, c.rest]) {
      const { sig, ...unsigned } = frame;
      const digest = hashTypedData({ domain: FILLER_PROTOCOL_DOMAIN, types: GATEWAY_MESSAGE_TYPES, primaryType: 'GatewayMessage', message: { bodyHash: gatewayBodyHash(unsigned) } });
      expect(recoverAddress(digest, sig).toLowerCase()).toBe(vectors.gateway);
    }
  });
  test('the proof digest is reproduced by the shipped encoder', () => {
    expect(proofDigest(c)).toBe(c.digest);
  });
  test('the structural rules hold: at least threshold signatures, signers ascending, ids matching the proof', () => {
    expect(settleAttestationsErrors(settleAttestationsPayload(c.ws))).toEqual([]);
    expect(c.ws.signatures.length).toBeGreaterThanOrEqual(c.ws.threshold);
  });
  test('every signer is a member of the set and its signature verifies over the digest', () => {
    for (const s of c.ws.signatures) expect(c.set.members).toContain(s.signer);
    if (!isCantonSource(c.ws.sourceChainId)) {
      for (const s of c.ws.signatures) expect(recoverAddress(c.digest, s.signature).toLowerCase()).toBe(s.signer);
      return;
    }
    c.ws.signatures.forEach((s, i) => {
      const entry = s as { signer: Hex; pubKey: Hex; signature: Hex };
      expect(addressOfSpki(entry.pubKey)).toBe(entry.signer);
      expect(vectors.attestors.find((a) => a.address === entry.signer)?.pubKey).toBe(entry.pubKey);
      const { r, s: sv } = rsFromMinimalDer(entry.signature);
      const rsv = c.rsv![i]!;
      expect(`0x${r}${sv}`).toBe(rsv.slice(0, 130));
      const sig = Signature.from(rsv);
      expect(BigInt(sig.s)).toBeLessThanOrEqual(BigInt('0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0')); // low-s
      expect(SigningKey.recoverPublicKey(c.digest, sig)).toBe(`0x${entry.pubKey.slice(2 + 46)}`);
    });
  });
});

describe('what the filler node submits', () => {
  test('EVM: settleSigs is the signature list in payload order', () => {
    expect(settleSigs(settleAttestationsPayload(evm.ws))).toEqual(evm.ws.signatures.map((s) => s.signature));
    expect(() => settleSigs(settleAttestationsPayload(canton.ws))).toThrow(/Canton source/);
  });
  test('Canton: cantonSigEntries is the Daml bundle, hex without 0x', () => {
    const bundle = cantonSigEntries(settleAttestationsPayload(canton.ws));
    expect(bundle).toHaveLength(canton.ws.signatures.length);
    for (const e of bundle) {
      expect(e.pubKey).toMatch(/^3056301006072a8648ce3d020106052b8104000a03420004[0-9a-f]{128}$/);
      expect(e.sig).toMatch(/^30[0-9a-f]+$/);
    }
    expect(() => cantonSigEntries(settleAttestationsPayload(evm.ws))).toThrow(/not a Canton source/);
  });
});

describe('invalid payloads a filler MUST refuse (T-7)', () => {
  const structural = ['threshold', 'ascending', 'attempt', 'setId', 'orderHash'];
  test.each(vectors.invalid.map((v) => [v.note, v] as const))('%s', (_, v) => {
    // schema-valid: the schema cannot see any of these
    expect(errorsOf({ ...v.payload, type: 'settle.attestations', id: evm.ws.id, fillerId: 'acme-markets', sentAt: evm.ws.sentAt, sig: evm.ws.sig })).toEqual([]);
    const errors = settleAttestationsErrors(v.payload);
    if (structural.includes(v.rule)) {
      expect(errors.length).toBeGreaterThan(0);
      return;
    }
    expect(errors).toEqual([]);
    const digest = proofDigest(evm, v.payload.proof);
    const ok = (v.payload.signatures as { signer: Hex; signature: Hex }[]).every(
      (s) => evm.set.members.includes(s.signer) && recoverAddress(digest, s.signature).toLowerCase() === s.signer,
    );
    expect(ok).toBe(false);
  });
  test('the outsider signs validly but is not a member', () => {
    expect(evm.set.members).not.toContain(vectors.outsider);
  });
});
