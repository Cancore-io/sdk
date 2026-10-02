import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { Hex } from '@cancore/contracts';
import { GatewayError, UnsupportedVersionError } from '../errors';
import { createTestGatewaySigner } from '../testing';
import { gatewayErrorOf, gatewayMessageDigest, keccakHex, verifyGatewayObject, verifyGatewayText } from './frames';

const GATEWAY_KEY: Hex = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const OTHER_KEY: Hex = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';
const FILLER = 'acme-1';

const gateway = createTestGatewaySigner(GATEWAY_KEY);
const impostor = createTestGatewaySigner(OTHER_KEY);
const expect_ = { gatewaySigner: gateway.address, fillerId: FILLER };

const offer = () =>
  gateway.frame({
    type: 'ticket.offer',
    fillerId: FILLER,
    orderHash: `0x${'11'.repeat(32)}`,
    attempt: 1,
    amountOut: '100',
    validFrom: '1790000000',
    validUntil: '1790000180',
    acceptBy: 1_790_000_010_000,
  });

describe('verifyGatewayText — every filler-gateway → filler frame (protocol §3.4, T-6)', () => {
  test('a frame signed by the pinned filler-gateway key, addressed to this filler, passes; raw and id are the bytes received', () => {
    const text = JSON.stringify(offer());
    const check = verifyGatewayText(text, expect_);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(Buffer.from(check.verified.raw).toString('utf8')).toBe(text);
    expect(check.verified.id).toBe(keccakHex(new TextEncoder().encode(text)));
  });

  test('the signature does not depend on key order or whitespace (JCS)', () => {
    const frame = offer();
    const reordered = Object.fromEntries(Object.entries(frame).reverse());
    const text = JSON.stringify(reordered, null, 2);
    expect(text).not.toBe(JSON.stringify(frame));
    expect(gatewayMessageDigest(reordered)).toBe(gatewayMessageDigest(frame));
    expect(verifyGatewayText(text, expect_)).toMatchObject({ ok: true });
  });

  test('a frame signed by another key is dropped (wrong-signer)', () => {
    const forged = impostor.frame({ ...offer(), sig: undefined });
    expect(verifyGatewayText(JSON.stringify(forged), expect_)).toEqual({ ok: false, reason: 'wrong-signer', type: 'ticket.offer' });
  });

  test('a field changed after signing is dropped: the signature recovers to another address', () => {
    const tampered = { ...offer(), amountOut: '1' };
    expect(verifyGatewayText(JSON.stringify(tampered), expect_)).toMatchObject({ ok: false, reason: 'wrong-signer' });
  });

  test('a frame addressed to another fillerId is dropped, even when signed correctly', () => {
    const other = gateway.frame({ ...offer(), sig: undefined, fillerId: 'someone-else' });
    expect(verifyGatewayText(JSON.stringify(other), expect_)).toMatchObject({ ok: false, reason: 'other-fillerId' });
  });

  test('fillerId may be absent only on auth.challenge and on a pre-auth error', () => {
    const { fillerId: _f, ...unaddressed } = offer();
    expect(verifyGatewayText(JSON.stringify(gateway.sign(unaddressed)), expect_)).toMatchObject({ ok: false, reason: 'no-fillerId' });
    const challenge = gateway.frame({ type: 'auth.challenge', nonce: `0x${'ab'.repeat(32)}`, expiresAt: '1790000030' });
    expect(verifyGatewayText(JSON.stringify(challenge), expect_)).toMatchObject({ ok: true });
    const error = gateway.frame({ type: 'error', code: 'UNAUTHENTICATED', message: 'no' });
    expect(verifyGatewayText(JSON.stringify(error), expect_)).toMatchObject({ ok: true });
  });

  test('a malformed signature (64 bytes, high-s) is dropped (bad-sig)', () => {
    const frame = offer();
    const short = { ...frame, sig: frame.sig.slice(0, 2 + 128) };
    expect(verifyGatewayText(JSON.stringify(short), expect_)).toMatchObject({ ok: false, reason: 'bad-sig' });

    const bytes = hexToBytes(frame.sig.slice(2));
    const s = BigInt(`0x${bytesToHex(bytes.subarray(32, 64))}`);
    const highS = (secp256k1.CURVE.n - s).toString(16).padStart(64, '0');
    const flipped = `0x${bytesToHex(bytes.subarray(0, 32))}${highS}${bytes[64] === 27 ? '1c' : '1b'}`;
    expect(verifyGatewayText(JSON.stringify({ ...frame, sig: flipped }), expect_)).toMatchObject({ ok: false, reason: 'bad-sig' });
  });

  test('a frame cut mid-way (a dropped connection) is dropped as not-json', () => {
    const text = JSON.stringify(offer());
    expect(verifyGatewayText(text.slice(0, text.length / 2), expect_)).toEqual({ ok: false, reason: 'not-json' });
  });

  test('shape: not an object, no type, no sentAt, no sig', () => {
    const raw = new Uint8Array();
    expect(verifyGatewayObject([1], raw, expect_)).toMatchObject({ reason: 'not-an-object' });
    expect(verifyGatewayObject({ sentAt: 1, sig: '0x' }, raw, expect_)).toMatchObject({ reason: 'no-type' });
    expect(verifyGatewayObject({ type: 'ping', sig: '0x' }, raw, expect_)).toMatchObject({ reason: 'no-sentAt' });
    expect(verifyGatewayObject({ type: 'ping', sentAt: 1.5, sig: '0x' }, raw, expect_)).toMatchObject({ reason: 'no-sentAt' });
    expect(verifyGatewayObject({ type: 'ping', sentAt: 1 }, raw, expect_)).toMatchObject({ reason: 'no-sig' });
  });

  test('unknown fields and unknown types pass (V-2); a fractional number fails canonicalisation', () => {
    const unknown = gateway.frame({ type: 'promo.banner', fillerId: FILLER, text: 'hi', nested: { a: [1, null] } });
    expect(verifyGatewayText(JSON.stringify(unknown), expect_)).toMatchObject({ ok: true });
    const extra = gateway.frame({ ...offer(), sig: undefined, hint: 'new optional field' });
    expect(verifyGatewayText(JSON.stringify(extra), expect_)).toMatchObject({ ok: true });
    const fraction = { ...offer(), ratio: 0.5 };
    expect(verifyGatewayText(JSON.stringify(fraction), expect_)).toMatchObject({ ok: false, reason: 'bad-sig' });
  });

  test('EIP-55 checksummed gatewaySigner in the config is accepted', () => {
    const checksummedLike = gateway.address.toUpperCase().replace('0X', '0x') as Hex;
    expect(verifyGatewayText(JSON.stringify(offer()), { ...expect_, gatewaySigner: checksummedLike })).toMatchObject({ ok: true });
  });
});

describe('gatewayErrorOf — error codes become typed errors', () => {
  test('a known code', () => {
    const error = gatewayErrorOf({ code: 'TICKET_CLOSED', message: 'after acceptBy', re: 'r-1' }, 409);
    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({ code: 'TICKET_CLOSED', known: true, re: 'r-1', httpStatus: 409 });
  });

  test('UNSUPPORTED_VERSION is its own class', () => {
    expect(gatewayErrorOf({ code: 'UNSUPPORTED_VERSION', message: 'v2 only' })).toBeInstanceOf(UnsupportedVersionError);
  });

  test('an unknown code is kept, generic (V-2)', () => {
    expect(gatewayErrorOf({ code: 'BRAND_NEW_CODE', message: 'x' })).toMatchObject({ code: 'BRAND_NEW_CODE', known: false });
    expect(gatewayErrorOf({})).toMatchObject({ code: 'UNKNOWN', known: false });
  });
});
