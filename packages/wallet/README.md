# `@cancore/wallet`

The wallet core: key material, signing, storage contracts, and the client for the Cancore
operations envelope. Runtime-agnostic — WebCrypto plus `@noble`/`@scure`, no browser globals,
no React.

```ts
import { generateEd25519KeyPair, cantonFingerprint } from '@cancore/wallet';
import { wallet, configureWalletOperations } from '@cancore/wallet/operations';
import { registerPasskey, evalPrf } from '@cancore/wallet/web';
```

| Entry | Needs | Holds |
| --- | --- | --- |
| `.` | any JS runtime with WebCrypto | keys, KDFs, signing, wallet records, Canton fingerprints |
| `./operations` | an injected request function | the prepare → sign → submit ceremony |
| `./web` | a browser | IndexedDB keystore, WebAuthn/PRF ceremonies |

**Full documentation: <https://docs.cancore.io/sdk/wallet>** — the contracts, unlocking and
restore, the operations envelope and its catalogue, and the handful of facts that are
expensive to learn from the outside (a signature is addressed by `legId`, never by position;
`legs: []` is a legal success; WebAuthn returns key-encryption material and is not a `Signer`).

Source of that page: `docs/docs/sdk/wallet.md` in this repo.

## Threat model

**What holds.** Nothing key-shaped is persisted in the clear: a record carries the public key,
a random per-record salt, a random 12-byte IV per wrap and AES-GCM ciphertext — no wrapping
key, no seed, no password verifier. Both KEK derivations ask WebCrypto for a **non-extractable**
key. A wrong password is indistinguishable from a corrupted record by design (both surface as
`WrongPasswordError`), and records carry a format version so a format change is a migration
rather than a lost wallet.

The assumption to carry away: **the at-rest security of a record equals the strength of the
password that wrapped it.** Nothing here raises that ceiling.

### What this does not protect against

**XSS on your origin.** The password protects the record at rest, not a live session. After
unlock a signer sits in memory for as long as the tab does, and any script on your origin can
use it — this package cannot tell your code from injected code. The mitigation is a `script-src`
Content Security Policy on the page that embeds the wallet, and it belongs to whoever serves
that page: a page that embeds this wallet with no script policy has no at-rest story worth the
name. Cancore's own deployment serves that policy in report-only mode today.

**The `@noble` fallback holds the seed in JS.** `createEd25519Signer` prefers a non-extractable
WebCrypto `CryptoKey`; when the runtime's `subtle` has no working Ed25519 it silently falls back
to `@noble/curves`, which keeps the raw 32-byte seed as a JS value for the session. Rare in a
current browser, normal in a headless runtime. The choice is on the type, so a build that cannot
accept it can refuse:

```ts
import { createEd25519Signer } from '@cancore/wallet';

const signer = await createEd25519Signer(seed);
if (signer.kind !== 'subtle') { /* refuse the pure-JS path */ }
```

**A ciphertext is not bound to its record.** `wrapSeed` / `unwrapSeed` pass no additional
authenticated data, so nothing cryptographically ties the bytes to the record, the public key
or the field they came from. Someone with write access to the store can transplant a salt, IV
and ciphertext between records; it is caught one step late, by the key-binding check after the
unwrap succeeded, rather than by authentication. Binding is in flight, not shipped.

**The same crypto exists twice in the Cancore app.** `src/lib/safeKeystore.ts` implements the
same PBKDF2-600k + AES-GCM-256 independently for the operator's Safe key export, and still reads
`cancore-safe-ed25519-key`, the plaintext backup format that predates it, migrating it on load.
That legacy reader is removed in the first release after this package is published to npm, and
unconditionally on **2026-12-31**, whichever comes first.

Full version, with the reasoning: <https://docs.cancore.io/sdk/wallet#threat-model>.
