import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { addressOf, BadSignatureError, recover, sign, TEST_KEYS, testKey } from './keys';
import { gatewaySigner, signGateway } from './protocol';

const digest = `0x${bytesToHex(keccak_256(utf8ToBytes('any 32 bytes')))}` as const;
const N = secp256k1.CURVE.n;

describe('TEST_KEYS — TEST ONLY, publicly derived', () => {
  test('every key is keccak256("cancore:test-kit:<role>:v1"), with its lowercase address', () => {
    for (const [role, key] of Object.entries(TEST_KEYS)) {
      expect(key.privateKey).toBe(`0x${bytesToHex(keccak_256(utf8ToBytes(`cancore:test-kit:${role}:v1`)))}`);
      expect(key.address).toBe(addressOf(key.privateKey));
      expect(key.address).toMatch(/^0x[0-9a-f]{40}$/);
      expect(testKey(role)).toEqual(key);
    }
  });

  test('the roles the mock needs exist and are pairwise distinct', () => {
    const roles = ['gateway', 'ticketSigner', 'foreignSigner', 'acmeQuote', 'acmeFiller', 'zetaQuote', 'zetaFiller'];
    expect(Object.keys(TEST_KEYS).sort()).toEqual([...roles].sort());
    expect(new Set(Object.values(TEST_KEYS).map((k) => k.address)).size).toBe(roles.length);
  });

  test('addressOf matches a known vector (private key 1)', () => {
    expect(addressOf('0x0000000000000000000000000000000000000000000000000000000000000001')).toBe('0x7e5f4552091a69125d5dfcb7b8c2659029395bdf');
  });
});

describe('sign / recover — 65 bytes r‖s‖v, low-s, v ∈ {27, 28}', () => {
  test('round trip recovers the signer', () => {
    const sig = sign(digest, TEST_KEYS.gateway.privateKey);
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
    expect([27, 28]).toContain(parseInt(sig.slice(130), 16));
    expect(BigInt(`0x${sig.slice(66, 130)}`) <= N / 2n).toBe(true);
    expect(recover(digest, sig)).toBe(TEST_KEYS.gateway.address);
  });

  test('a high-s twin of a valid signature is rejected (OpenZeppelin ECDSA.recover)', () => {
    const sig = sign(digest, TEST_KEYS.acmeQuote.privateKey);
    const s = BigInt(`0x${sig.slice(66, 130)}`);
    const v = parseInt(sig.slice(130), 16);
    const twin = `0x${sig.slice(2, 66)}${(N - s).toString(16).padStart(64, '0')}${(v === 27 ? 28 : 27).toString(16)}` as const;
    expect(() => recover(digest, twin)).toThrow(BadSignatureError);
  });

  test.each([
    ['v = 0', (sig: string) => `${sig.slice(0, 130)}00`],
    ['v = 29', (sig: string) => `${sig.slice(0, 130)}1d`],
    ['64 bytes', (sig: string) => sig.slice(0, 130)],
    ['not hex', (sig: string) => `${sig.slice(0, 128)}zz1b`],
    ['r = 0', (sig: string) => `0x${'00'.repeat(32)}${sig.slice(66)}`],
    ['s = 0', (sig: string) => `${sig.slice(0, 66)}${'00'.repeat(32)}${sig.slice(130)}`],
    ['r = n', (sig: string) => `0x${N.toString(16)}${sig.slice(66)}`],
    ['all zero', () => `0x${'00'.repeat(64)}1b`],
  ])('%s is rejected', (_name, mutate) => {
    const sig = sign(digest, TEST_KEYS.acmeQuote.privateKey);
    expect(() => recover(digest, mutate(sig) as `0x${string}`)).toThrow(BadSignatureError);
  });
});

describe('gateway signature over GatewayMessage{keccak256(JCS(message without sig))}', () => {
  const offerA = '{"type":"ticket.offer","fillerId":"acme-markets","sentAt":1789999410000,"orderHash":"0x11","attempt":0}';
  const offerB = '{ "attempt": 0,\n  "orderHash": "0x11", "sentAt": 1789999410000, "fillerId": "acme-markets", "type": "ticket.offer" }';

  test('A5: a signature made on one text verifies on another text of the same message', () => {
    const signed = signGateway(JSON.parse(offerA) as Record<string, unknown>, TEST_KEYS.gateway.privateKey);
    const other = { ...(JSON.parse(offerB) as Record<string, unknown>), sig: signed.sig };
    expect(gatewaySigner(other)).toBe(TEST_KEYS.gateway.address);
  });

  test('a changed field no longer recovers to the gateway', () => {
    const signed = signGateway(JSON.parse(offerA) as Record<string, unknown>, TEST_KEYS.gateway.privateKey);
    expect(gatewaySigner({ ...signed, attempt: 1 })).not.toBe(TEST_KEYS.gateway.address);
  });

  test('A8: a draw record signed by the gateway recovers to the gateway', () => {
    const record = { orderHash: '0x22', attempts: [{ attempt: 0, r: '417828', winnerFillerId: 'acme-markets' }] };
    expect(gatewaySigner(signGateway(record, TEST_KEYS.gateway.privateKey))).toBe(TEST_KEYS.gateway.address);
  });

  test('a message without sig has no signer', () => {
    expect(() => gatewaySigner({ type: 'ping' })).toThrow(BadSignatureError);
  });
});

test('a raw secp256k1 signature over the digest verifies against the public key of the signer', () => {
  const sig = sign(digest, TEST_KEYS.ticketSigner.privateKey);
  const pub = secp256k1.getPublicKey(hexToBytes(TEST_KEYS.ticketSigner.privateKey.slice(2)));
  expect(secp256k1.verify(hexToBytes(sig.slice(2, 130)), hexToBytes(digest.slice(2)), pub)).toBe(true);
});
