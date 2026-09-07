/**
 * KAT (Known-Answer-Test) suite for Ed25519 derivation and signing — CAN-411
 * gap #1 ("blocking, first code"). Fixed reference vectors from RFC 8032 §7.1:
 *
 *   • TEST 1:    Empty message (0 bytes)
 *   • TEST 2:    1-byte message (0x72)
 *   • TEST 3:    2-byte message (0xaf82)
 *   • TEST 1024: 1023-byte message — spans multiple SHA-512 blocks (64 bytes
 *     each), unlike TEST 1-3 which all fit in one; catches a hasher that only
 *     handles a single block correctly.
 *
 * All four secret keys, public keys, messages and signatures below were
 * extracted programmatically from the raw RFC text (curl
 * https://www.rfc-editor.org/rfc/rfc8032.txt, parsed §7.1 by script — no
 * hand-copying, which twice silently dropped a byte earlier in this task) and
 * independently cross-checked against Node's own `node:crypto` Ed25519
 * (OpenSSL), not just against the `@noble/curves` implementation under test.
 *
 * L (group order, RFC 8032 §5.1) used to build the non-malleability check.
 */
import { hexToBytes, bytesToHex } from './bytes';
import {
  ed25519PublicKeyFromSeed,
  createEd25519Signer,
  signWithEd25519Signer,
  signWithSubtle,
  verifyEd25519,
  isSubtleEd25519Supported,
} from './ed25519';

const VECTORS = [
  {
    name: 'TEST 1 (0 bytes)',
    seed: hexToBytes('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'),
    pubKey: hexToBytes('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'),
    msg: new Uint8Array(0),
    sig: hexToBytes('e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'),
  },
  {
    name: 'TEST 2 (1 byte)',
    seed: hexToBytes('4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb'),
    pubKey: hexToBytes('3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c'),
    msg: hexToBytes('72'),
    sig: hexToBytes('92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00'),
  },
  {
    name: 'TEST 3 (2 bytes)',
    seed: hexToBytes('c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7'),
    pubKey: hexToBytes('fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025'),
    msg: hexToBytes('af82'),
    sig: hexToBytes('6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a'),
  },
  {
    name: 'TEST 1024 (1023 bytes, multi-block SHA-512)',
    seed: hexToBytes('f5e5767cf153319517630f226876b86c8160cc583bc013744c6bf255f5cc0ee5'),
    pubKey: hexToBytes('278117fc144c72340f67d0f2316e8386ceffbf2b2428c9c51fef7c597f1d426e'),
    msg: hexToBytes(
      '08b8b2b733424243760fe426a4b54908632110a66c2f6591eabd3345e3e4eb98fa6e264bf09efe12ee50f8f54e9f77b1' +
        'e355f6c50544e23fb1433ddf73be84d879de7c0046dc4996d9e773f4bc9efe5738829adb26c81b37c93a1b270b20329d' +
        '658675fc6ea534e0810a4432826bf58c941efb65d57a338bbd2e26640f89ffbc1a858efcb8550ee3a5e1998bd177e93a' +
        '7363c344fe6b199ee5d02e82d522c4feba15452f80288a821a579116ec6dad2b3b310da903401aa62100ab5d1a36553e' +
        '06203b33890cc9b832f79ef80560ccb9a39ce767967ed628c6ad573cb116dbefefd75499da96bd68a8a97b928a8bbc10' +
        '3b6621fcde2beca1231d206be6cd9ec7aff6f6c94fcd7204ed3455c68c83f4a41da4af2b74ef5c53f1d8ac70bdcb7ed1' +
        '85ce81bd84359d44254d95629e9855a94a7c1958d1f8ada5d0532ed8a5aa3fb2d17ba70eb6248e594e1a2297acbbb39d' +
        '502f1a8c6eb6f1ce22b3de1a1f40cc24554119a831a9aad6079cad88425de6bde1a9187ebb6092cf67bf2b13fd65f270' +
        '88d78b7e883c8759d2c4f5c65adb7553878ad575f9fad878e80a0c9ba63bcbcc2732e69485bbc9c90bfbd62481d9089b' +
        'eccf80cfe2df16a2cf65bd92dd597b0707e0917af48bbb75fed413d238f5555a7a569d80c3414a8d0859dc65a46128ba' +
        'b27af87a71314f318c782b23ebfe808b82b0ce26401d2e22f04d83d1255dc51addd3b75a2b1ae0784504df543af8969b' +
        'e3ea7082ff7fc9888c144da2af58429ec96031dbcad3dad9af0dcbaaaf268cb8fcffead94f3c7ca495e056a9b47acdb7' +
        '51fb73e666c6c655ade8297297d07ad1ba5e43f1bca32301651339e22904cc8c42f58c30c04aafdb038dda0847dd988d' +
        'cda6f3bfd15c4b4c4525004aa06eeff8ca61783aacec57fb3d1f92b0fe2fd1a85f6724517b65e614ad6808d6f6ee34df' +
        'f7310fdc82aebfd904b01e1dc54b2927094b2db68d6f903b68401adebf5a7e08d78ff4ef5d63653a65040cf9bfd4aca7' +
        '984a74d37145986780fc0b16ac451649de6188a7dbdf191f64b5fc5e2ab47b57f7f7276cd419c17a3ca8e1b939ae49e4' +
        '88acba6b965610b5480109c8b17b80e1b7b750dfc7598d5d5011fd2dcc5600a32ef5b52a1ecc820e308aa342721aac09' +
        '43bf6686b64b2579376504ccc493d97e6aed3fb0f9cd71a43dd497f01f17c0e2cb3797aa2a2f256656168e6c496afc5f' +
        'b93246f6b1116398a346f1a641f3b041e989f7914f90cc2c7fff357876e506b50d334ba77c225bc307ba537152f3f161' +
        '0e4eafe595f6d9d90d11faa933a15ef1369546868a7f3a45a96768d40fd9d03412c091c6315cf4fde7cb68606937380d' +
        'b2eaaa707b4c4185c32eddcdd306705e4dc1ffc872eeee475a64dfac86aba41c0618983f8741c5ef68d3a101e8a3b8ca' +
        'c60c905c15fc910840b94c00a0b9d0',
    ),
    sig: hexToBytes('0aab4c900501b3e24d7cdf4663326a3a87df5e4843b2cbdb67cbf6e460fec350aa5371b1508f9f4528ecea23c436d94b5e8fcd4f681e30a6ac00a9704a188a03'),
  },
];

// Order of the edwards25519 base point (RFC 8032 §5.1)
const L = 2n ** 252n + 27742317777372353535851937790883648493n;

function bytesToBigIntLE(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}

function bigIntToBytesLE(n: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

describe('Ed25519 KAT (RFC 8032 §7.1) — required CI gate, CAN-411', () => {
  for (const vector of VECTORS) {
    describe(vector.name, () => {
      it('derives exact reference public key', () => {
        expect(bytesToHex(ed25519PublicKeyFromSeed(vector.seed))).toBe(bytesToHex(vector.pubKey));
      });

      it('produces exact reference signature (@noble/curves)', async () => {
        // Signer built by hand (bypassing createEd25519Signer's feature
        // detection) so the noble fallback path is always exercised here,
        // independently of whether this runtime's WebCrypto supports
        // Ed25519 — otherwise createEd25519Signer would always pick
        // 'subtle' wherever it's available and this branch would never run.
        const signer = { kind: 'noble' as const, seed: vector.seed };
        const signature = await signWithEd25519Signer(signer, vector.msg);
        expect(bytesToHex(signature)).toBe(bytesToHex(vector.sig));
      });

      it('produces exact reference signature (WebCrypto subtle)', async () => {
        if (!isSubtleEd25519Supported()) {
          if (process.env.CI) {
            throw new Error('WebCrypto subtle Ed25519 must be supported in CI environment (Node 24)');
          }
          return;
        }
        const signer = await createEd25519Signer(vector.seed);
        if (process.env.CI) {
          expect(signer.kind).toBe('subtle');
        }
        if (signer.kind !== 'subtle') return;
        const signature = await signWithSubtle(signer.key, vector.msg);
        expect(bytesToHex(signature)).toBe(bytesToHex(vector.sig));
      });

      it('verifies reference signature', async () => {
        expect(await verifyEd25519(vector.pubKey, vector.sig, vector.msg)).toBe(true);
      });
    });
  }

  describe('Negative verification test vectors', () => {
    it('rejects tampered R component of signature', async () => {
      const v = VECTORS[0];
      const tampered = new Uint8Array(v.sig);
      tampered[0] ^= 0xff;
      expect(await verifyEd25519(v.pubKey, tampered, v.msg)).toBe(false);
    });

    it('rejects tampered message', async () => {
      const v = VECTORS[1];
      const tamperedMsg = new Uint8Array([0x73]);
      expect(await verifyEd25519(v.pubKey, v.sig, tamperedMsg)).toBe(false);
    });

    it('rejects signature against wrong public key', async () => {
      const v = VECTORS[2];
      const wrongPubKey = VECTORS[0].pubKey;
      expect(await verifyEd25519(wrongPubKey, v.sig, v.msg)).toBe(false);
    });

    it('rejects all-zero signature', async () => {
      const v = VECTORS[0];
      const zeroSig = new Uint8Array(64);
      expect(await verifyEd25519(v.pubKey, zeroSig, v.msg)).toBe(false);
    });

    it('rejects non-canonical signature S + L (RFC 8032 §5.1.7 non-malleability)', async () => {
      const vector = VECTORS[0];
      const s = bytesToBigIntLE(vector.sig.slice(32));
      expect(s < L).toBe(true);
      const sPlusL = s + L;
      const tampered = new Uint8Array(64);
      tampered.set(vector.sig.slice(0, 32), 0);
      tampered.set(bigIntToBytesLE(sPlusL, 32), 32);
      expect(await verifyEd25519(vector.pubKey, tampered, vector.msg)).toBe(false);
    });
  });
});
