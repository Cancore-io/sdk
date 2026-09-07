import { ed25519 } from '@noble/curves/ed25519';
import { binaryStringToBytes, bytesToBinaryString, bytesToHex } from './bytes';
import { createEd25519Signer, generateEd25519KeyPair } from './ed25519';
import { createPasskeySigningProvider, LOGIN_CHALLENGE_PREFIX } from './provider';

describe('createPasskeySigningProvider (LoopProvider-shaped { public_key, signMessage })', () => {
  it('exposes public_key as the hex-encoded Ed25519 public key', async () => {
    const keyPair = generateEd25519KeyPair();
    const signer = await createEd25519Signer(keyPair.seed);
    const provider = createPasskeySigningProvider(signer, bytesToHex(keyPair.publicKey));

    expect(provider.public_key).toBe(bytesToHex(keyPair.publicKey));
    expect(provider.public_key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('signMessage returns a lowercase 128-char hex signature matching signatureToHex fast path', async () => {
    const keyPair = generateEd25519KeyPair();
    const signer = await createEd25519Signer(keyPair.seed);
    const provider = createPasskeySigningProvider(signer, bytesToHex(keyPair.publicKey));

    const signatureHex = await provider.signMessage('a login challenge string');
    expect(signatureHex).toMatch(/^[0-9a-f]{128}$/);
  });

  it('signs the exact bytes of the message (binary-string convention), verifiable independently', async () => {
    const keyPair = generateEd25519KeyPair();
    const signer = await createEd25519Signer(keyPair.seed);
    const provider = createPasskeySigningProvider(signer, bytesToHex(keyPair.publicKey));

    const message = 'cancore/prepared-command/{"foo":"bar"}';
    const signatureHex = await provider.signMessage(message);

    const signature = Uint8Array.from(Buffer.from(signatureHex, 'hex'));
    const messageBytes = binaryStringToBytes(message);
    expect(ed25519.verify(signature, messageBytes, keyPair.publicKey)).toBe(true);
  });

  // WAL-5 step 1. The test above uses an all-ASCII message, where the
  // binary-string convention and `new TextEncoder().encode()` produce the same
  // bytes — so it cannot see the one mistake worth catching here. Every byte
  // above 0x7f is where they diverge: UTF-8 would re-encode 0x80 as two bytes
  // (0xc2 0x80) and the signature would be over a message the caller never
  // sent. Topology hashes and prepared commands routinely carry such bytes.
  it('signs raw bytes, not UTF-8: a message with bytes above 0x7f is not re-encoded', async () => {
    const keyPair = generateEd25519KeyPair();
    const signer = await createEd25519Signer(keyPair.seed);
    const provider = createPasskeySigningProvider(signer, bytesToHex(keyPair.publicKey));

    // 0x00 0x80 0xc3 0xff — a NUL, the first byte UTF-8 widens, a lead byte,
    // and 0xff, which is not valid UTF-8 at all.
    const rawBytes = new Uint8Array([0x00, 0x80, 0xc3, 0xff, 0x41]);
    const message = bytesToBinaryString(rawBytes);
    const utf8Bytes = new TextEncoder().encode(message);
    expect(utf8Bytes).not.toEqual(rawBytes); // the two encodings really do differ here

    const signature = Uint8Array.from(
      Buffer.from(await provider.signMessage(message), 'hex'),
    );

    expect(ed25519.verify(signature, rawBytes, keyPair.publicKey)).toBe(true);
    expect(ed25519.verify(signature, utf8Bytes, keyPair.publicKey)).toBe(false);
  });

  it('does not implement Loop-specific transaction methods (foundation scope only)', async () => {
    const keyPair = generateEd25519KeyPair();
    const signer = await createEd25519Signer(keyPair.seed);
    const provider = createPasskeySigningProvider(signer, bytesToHex(keyPair.publicKey));

    expect((provider as unknown as { transfer?: unknown }).transfer).toBeUndefined();
    expect((provider as unknown as { submitAndWaitForTransaction?: unknown }).submitAndWaitForTransaction).toBeUndefined();
  });
});

describe('domain-separated signing methods (REQ-WAL-12)', () => {
  async function makeProvider() {
    const keyPair = generateEd25519KeyPair();
    const signer = await createEd25519Signer(keyPair.seed);
    return { keyPair, provider: createPasskeySigningProvider(signer, bytesToHex(keyPair.publicKey)) };
  }

  it('signChallenge signs a Cancore login challenge (hex, verifiable, same bytes as signMessage)', async () => {
    const { keyPair, provider } = await makeProvider();
    const challenge = `${LOGIN_CHALLENGE_PREFIX}2026-07-17 sig:0123456789abcdef`;

    const signatureHex = await provider.signChallenge!(challenge);
    expect(signatureHex).toMatch(/^[0-9a-f]{128}$/);
    expect(
      ed25519.verify(Uint8Array.from(Buffer.from(signatureHex, 'hex')), binaryStringToBytes(challenge), keyPair.publicKey),
    ).toBe(true);
    // Ed25519 is deterministic: same bytes as the legacy signMessage path.
    expect(await provider.signMessage(challenge)).toBe(signatureHex);
  });

  it('signChallenge refuses non-challenge input: raw hashes, missing prefix, non-ASCII', async () => {
    const { provider } = await makeProvider();
    const raw32 = bytesToBinaryString(new Uint8Array(32).fill(7));

    await expect(provider.signChallenge!(raw32)).rejects.toThrow(/not a Cancore login challenge/);
    await expect(provider.signChallenge!('sign this please')).rejects.toThrow(/not a Cancore login challenge/);
    await expect(provider.signChallenge!(`${LOGIN_CHALLENGE_PREFIX}\x00binary`)).rejects.toThrow(
      /not a Cancore login challenge/,
    );
  });

  it('signPreparedHash signs a 32-byte base64 hash and returns a verifiable base64 signature', async () => {
    const { keyPair, provider } = await makeProvider();
    const hash = new Uint8Array(32).map((_, i) => i);
    const hashB64 = btoa(bytesToBinaryString(hash));

    const signatureB64 = await provider.signPreparedHash!(hashB64);
    const signature = binaryStringToBytes(atob(signatureB64));
    expect(signature).toHaveLength(64);
    expect(ed25519.verify(signature, hash, keyPair.publicKey)).toBe(true);
  });

  it('signPreparedHash refuses wrong sizes (34-byte topology multihash, 31 bytes) and non-base64', async () => {
    const { provider } = await makeProvider();
    const multihash = btoa(bytesToBinaryString(new Uint8Array([0x12, 0x20, ...new Array(32).fill(9)])));
    const short = btoa(bytesToBinaryString(new Uint8Array(31).fill(1)));

    await expect(provider.signPreparedHash!(multihash)).rejects.toThrow(/34 bytes/);
    await expect(provider.signPreparedHash!(short)).rejects.toThrow(/31 bytes/);
    await expect(provider.signPreparedHash!('*not-base64*')).rejects.toThrow(/not valid base64/);
    // An ASCII login challenge is never exactly 32 bytes of decoded base64 by
    // construction here — and even a crafted one must not slip through:
    await expect(provider.signPreparedHash!('Welcome to Cancore')).rejects.toThrow();
  });
});

/**
 * CAN-412 / TC-WAL-52+107 — the Gherkin "arbitrary inputs do not pass the
 * wrong channel" Examples that are not already pinned above. Already covered
 * by the two tests preceding this block: base64 34-byte topology multihash,
 * 31-byte base64, non-base64, printable ASCII without the prefix
 * ('sign this please'), and binary non-printables (raw32, and with the
 * challenge prefix). Added here: 33-byte base64, a full login-challenge text
 * (prefix + date + sig suffix, as `/auth/challenge` really issues it), and a
 * base64-encoded 32-byte hash fed to signChallenge — printable ASCII, so only
 * the missing prefix can save it.
 */
describe('cross-channel refusals — the CAN-412 Examples matrix (REQ-WAL-12)', () => {
  type Provider = ReturnType<typeof createPasskeySigningProvider>;
  let provider: Provider;

  beforeAll(async () => {
    const keyPair = generateEd25519KeyPair();
    const signer = await createEd25519Signer(keyPair.seed);
    provider = createPasskeySigningProvider(signer, bytesToHex(keyPair.publicKey));
  });

  it.each([
    [
      'signPreparedHash ← base64 of 33 bytes',
      async () => {
        const value = btoa(bytesToBinaryString(new Uint8Array(33).map((_, i) => (i * 7) & 0xff)));
        await expect(provider.signPreparedHash!(value)).rejects.toThrow(/33 bytes/);
      },
    ],
    [
      'signPreparedHash ← a full login-challenge text',
      async () => {
        const challenge = `${LOGIN_CHALLENGE_PREFIX}2026-08-20 sig:0123456789abcdef`;
        await expect(provider.signPreparedHash!(challenge)).rejects.toThrow();
      },
    ],
    [
      'signChallenge ← base64 of a 32-byte prepared-transaction hash',
      async () => {
        // Base64 is printable ASCII: only the absent challenge prefix stands
        // between it and the login channel.
        const hashB64 = btoa(bytesToBinaryString(new Uint8Array(32).map((_, i) => (i * 13) & 0xff)));
        await expect(provider.signChallenge!(hashB64)).rejects.toThrow(/not a Cancore login challenge/);
      },
    ],
  ])('refuses before Ed25519: %s', (_label, run) => run());
});

/**
 * CAN-412 — seeded, deterministic property corpus (no external
 * property-testing dependency). Every case is built from an equivalence class
 * whose lawful channel is known BY CONSTRUCTION, which keeps the oracle
 * independent of the implementation under test:
 *
 * - valid challenge     prefix + printable ASCII          → signChallenge only
 * - valid prepared hash base64 of exactly 32 random bytes → signPreparedHash only
 *   (the two accepted classes are provably disjoint: the challenge prefix
 *   contains a space, which is not in the base64 alphabet)
 * - near-miss sizes     base64 of 0/16/31/33/34/35/64 B   → neither channel
 * - printable, no prefix, non-base64 punctuation           → neither channel
 * - binary with non-printable control codes                → neither channel
 * - base64url alphabet (34-char swap of +/ for -_)         → neither channel
 *
 * The xorshift32 stream is fixed-seed, so a failure names the exact case and
 * reproduces forever.
 */
describe('domain separation over a deterministic xorshift corpus (REQ-WAL-12, TC-WAL-107)', () => {
  const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const PRINTABLE = `${B64_ALPHABET} .,;:?!`;
  // Deliberately outside both the base64 alphabet and ASCII whitespace (which
  // forgiving-base64 would strip) — their presence must make base64 decoding
  // fail, not merely look odd.
  const NON_BASE64_PUNCTUATION = '*!#$%&()<>[]{}|';

  /** Fixed-seed xorshift32 — deterministic, dependency-free. */
  function xorshift32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state ^= (state << 13) >>> 0;
      state ^= state >>> 17;
      state ^= (state << 5) >>> 0;
      return state >>> 0;
    };
  }

  type LawfulChannel = 'challenge' | 'prepared' | 'none';

  interface CorpusCase {
    label: string;
    input: string;
    lawful: LawfulChannel;
    /** For 'prepared' cases: the exact 32 bytes the signature must cover. */
    hashBytes?: Uint8Array;
  }

  function buildCorpus(): CorpusCase[] {
    const next = xorshift32(0x43414e2d); // "CAN-" — fixed seed, do not change
    const byte = () => next() & 0xff;
    const pick = (alphabet: string) => alphabet[byte() % alphabet.length];
    const randomBytes = (length: number) => Uint8Array.from({ length }, byte);

    const cases: CorpusCase[] = [];
    const CASES_PER_CLASS = 34;

    for (let i = 0; i < CASES_PER_CLASS; i += 1) {
      // A real-shaped challenge: prefix + printable tail of varying length.
      const tailLength = 8 + (byte() % 40);
      const tail = Array.from({ length: tailLength }, () => pick(PRINTABLE)).join('');
      cases.push({
        label: `valid challenge #${i}`,
        input: `${LOGIN_CHALLENGE_PREFIX}2026-08-20 ${tail}`,
        lawful: 'challenge',
      });

      // Exactly 32 random bytes, standard base64.
      const hashBytes = randomBytes(32);
      cases.push({
        label: `valid prepared hash #${i}`,
        input: btoa(bytesToBinaryString(hashBytes)),
        lawful: 'prepared',
        hashBytes,
      });

      // Near-miss sizes around the 32-byte contract.
      const size = [0, 1, 16, 31, 33, 34, 35, 64][i % 8];
      cases.push({
        label: `base64 of ${size} bytes #${i}`,
        input: btoa(bytesToBinaryString(randomBytes(size))),
        lawful: 'none',
      });

      // Printable ASCII, no prefix, and at least one character that forgiving
      // base64 cannot swallow — so neither channel can accept it.
      const length = 10 + (byte() % 40);
      const chars = Array.from({ length }, () => pick(PRINTABLE)).join('').split('');
      chars[byte() % length] = NON_BASE64_PUNCTUATION[byte() % NON_BASE64_PUNCTUATION.length];
      cases.push({ label: `printable without prefix #${i}`, input: chars.join(''), lawful: 'none' });

      // Binary with real control codes (excluding ASCII whitespace, which
      // atob strips) — never printable, never base64.
      const binary = randomBytes(12 + (byte() % 30));
      binary[0] = 0x01 + (byte() % 8); // 0x01..0x08: control, not whitespace
      cases.push({
        label: `binary non-printables #${i}`,
        input: bytesToBinaryString(binary),
        lawful: 'none',
      });

      // URL-safe alphabet is a different encoding: not standard base64.
      // 32 random bytes can base64-encode without any +/ (p ≈ 26%), which
      // would make the swap a no-op and the value legitimate standard base64 —
      // so force the URL-safe alphabet to actually appear, before the '='
      // padding (44-char encoding of 32 bytes, padding at index 43).
      let urlSafe = btoa(bytesToBinaryString(randomBytes(32)))
        .replaceAll('+', '-')
        .replaceAll('/', '_');
      if (!/[-_]/.test(urlSafe)) {
        const chars = urlSafe.split('');
        chars[byte() % 43] = '-';
        urlSafe = chars.join('');
      }
      cases.push({ label: `base64url 32 bytes #${i}`, input: urlSafe, lawful: 'none' });
    }
    return cases;
  }

  it('every corpus input passes only its lawful channel, or none', async () => {
    const keyPair = generateEd25519KeyPair();
    const signer = await createEd25519Signer(keyPair.seed);
    const provider = createPasskeySigningProvider(signer, bytesToHex(keyPair.publicKey));
    const failures: string[] = [];

    for (const corpusCase of buildCorpus()) {
      // --- signChallenge ---
      let challengeAccepted = false;
      try {
        const signatureHex = await provider.signChallenge!(corpusCase.input);
        challengeAccepted = true;
        if (corpusCase.lawful !== 'challenge') {
          failures.push(`${corpusCase.label}: signChallenge accepted a non-challenge`);
        } else {
          const signature = Uint8Array.from(Buffer.from(signatureHex, 'hex'));
          if (!ed25519.verify(signature, binaryStringToBytes(corpusCase.input), keyPair.publicKey)) {
            failures.push(`${corpusCase.label}: challenge signature does not verify over the exact bytes`);
          }
        }
      } catch {
        if (corpusCase.lawful === 'challenge') {
          failures.push(`${corpusCase.label}: signChallenge refused a lawful challenge`);
        }
      }

      // --- signPreparedHash ---
      let preparedAccepted = false;
      try {
        const signatureB64 = await provider.signPreparedHash!(corpusCase.input);
        preparedAccepted = true;
        if (corpusCase.lawful !== 'prepared') {
          failures.push(`${corpusCase.label}: signPreparedHash accepted a non-32-byte-base64 input`);
        } else {
          const signature = binaryStringToBytes(atob(signatureB64));
          if (
            signature.length !== 64 ||
            !ed25519.verify(signature, corpusCase.hashBytes!, keyPair.publicKey)
          ) {
            failures.push(`${corpusCase.label}: prepared-hash signature does not verify over the hash`);
          }
        }
      } catch {
        if (corpusCase.lawful === 'prepared') {
          failures.push(`${corpusCase.label}: signPreparedHash refused a lawful 32-byte hash`);
        }
      }

      if (challengeAccepted && preparedAccepted) {
        failures.push(`${corpusCase.label}: accepted by BOTH channels — domain separation broken`);
      }
    }

    expect(failures).toEqual([]);
    // The corpus really is ~200 cases over the equivalence classes — a silent
    // generator regression would otherwise make this test vacuous.
    expect(buildCorpus()).toHaveLength(204);
  });
});
