# `@cancore/wallet`

The wallet core: key material, signing, storage contracts, and the client for the Cancore
operations envelope. Runtime-agnostic — WebCrypto plus `@noble`/`@scure`, no browser globals,
no React, no framework.

```bash
npm install @cancore/wallet
```

| Entry | Needs | Holds |
| --- | --- | --- |
| `@cancore/wallet` | any JS runtime with WebCrypto (Node ≥ 20, modern browsers) | keys, KDFs, records, mnemonics, signing, Canton identity |
| `@cancore/wallet/operations` | an injected request function | the prepare → sign → submit ceremony |
| `@cancore/wallet/web` | a browser | IndexedDB keystore, WebAuthn/PRF ceremonies |

ESM only. The core is WebCrypto and `@noble`; a runtime old enough to need CommonJS has no
`crypto.subtle` to offer it.

## Quick start

```ts
import {
  deriveWalletKey,
  newMnemonic,
  importKeyPasswordWallet,
  unlockKeyPasswordWallet,
  cantonFingerprint,
} from '@cancore/wallet';

// 1. New wallet from a fresh recovery phrase.
const mnemonic = newMnemonic();                       // 12 words, English
const derived = deriveWalletKey(mnemonic);            // SLIP-0010 over Ed25519

// 2. Wrap it under a password. The result is what you persist.
const created = await importKeyPasswordWallet(derived.seedHex, password, {}, mnemonic);
await keystore.put(created.publicKeyHex, created.record);

// 3. Later: open it again.
const opened = await unlockKeyPasswordWallet(created.record, password);
if (opened.upgraded) await keystore.put(opened.publicKeyHex, opened.upgraded);  // see "Records"

// 4. The public key is the Canton identity.
cantonFingerprint(opened.publicKeyHex);               // "1220…" — the party namespace
```

## Key material

| Function | Returns |
| --- | --- |
| `generateEd25519KeyPair()` | `{ seed, publicKey }` from the runtime CSPRNG |
| `ed25519PublicKeyFromSeed(seed)` | the public key for a seed you already have |
| `deriveWalletKey(mnemonic, scheme?)` | `{ scheme, seed, seedHex, publicKeyHex }` |
| `mnemonicToEd25519Seed(mnemonic, scheme?)` | just the 32-byte seed |
| `slip10DeriveEd25519(seed, path)` | SLIP-0010 derivation at an explicit path |

`CANTON_DERIVATION_PATH` is `m/44'/6767'/0'/0'/0'`. The `scheme` argument picks between
`'standard'` (that path) and `'legacy'` (the master key with no derivation), because wallets
created before the path existed are still in use — see **Restore** below.

## Recovery phrases

```ts
newMnemonic(strengthBits?, language?)   // 128 (12 words) or 256 (24); en, zh, ko, es, fr
isValidMnemonic(mnemonic, language?)
detectMnemonicLanguage(mnemonic, preferred?)
describeMnemonicError(mnemonic, language?)   // { code, params } or null when valid
normalizeMnemonic(mnemonic)                  // NFKD, collapsed whitespace, lower case
wordlistFor(language)
```

`describeMnemonicError` returns an i18n **key**, not a sentence: the package does not know
your product's language. `MNEMONIC_LANGUAGES` lists what is supported.

### Restore

A phrase alone does not say which derivation made the wallet, so restoring means trying both
and asking which one the network already knows:

```ts
import { resolveRestoredSeed, makeChallengeAccountProbe, matchPhraseToParty } from '@cancore/wallet';

const probe = makeChallengeAccountProbe((publicKeyHex) => api.requestChallenge(publicKeyHex));
const found = await resolveRestoredSeed(mnemonic, probe);   // DerivedWalletKey | null
```

`matchPhraseToParty(mnemonic, partyId)` answers the same question offline when you already
know the party id: it returns the matching derivation, the fingerprint the party's namespace
demands, and what each derivation actually produced — which is what turns "wrong phrase" into
a message a person can act on.

## Records: what is persisted, and how

A record is the only thing that touches disk. It holds the public key, a random per-record
salt, a random 12-byte IV per wrapped secret, AES-GCM ciphertext, the iteration count and a
format version. **No wrapping key, no seed, no password verifier.**

```ts
importKeyPasswordWallet(privateKeyHex, password, opts?, mnemonic?)  // create
unlockKeyPasswordWallet(record, password, opts?)                    // open
revealWalletSecret(record, password)                                // { privateKeyHex, mnemonic }
changeKeyPasswordWalletPassword(record, oldPassword, newPassword, opts?)
walletRecordVersion(record)                                         // absent version means 1
```

**Format v2** (`WALLET_RECORD_VERSION`) derives **two** key-encryption keys from one PBKDF2
pass — PBKDF2 for the cost, HKDF for the separation — and binds every ciphertext to the
record it belongs to:

- KEK info strings: `cancore/wallet/kek/seed/v2`, `cancore/wallet/kek/mnemonic/v2`. The seed
  and the recovery phrase are wrapped under different keys, because the phrase is the more
  dangerous of the two to leak: a seed is ours, a phrase types into any BIP39 wallet.
- AAD: `cancore/wallet/v2|pbkdf2|<publicKeyHex>|<role>`. Bytes moved between records, or
  between the two fields of one record, fail to decrypt — at the primitive, not three steps
  later.

v1 records (`LEGACY_WALLET_RECORD_VERSION`, one KEK, no AAD) still open. `unlockKeyPasswordWallet`
returns `upgraded` when the record on disk is behind — an older format, or fewer PBKDF2
iterations than this build uses (`PBKDF2_ITERATIONS`, 600 000, SHA-256). **Persist it**: the
upgrade is only real once written back, and you are the one holding the keystore. The moment a
record can be re-wrapped at all is the moment the password is in memory, which is why it
happens on unlock and nowhere else.

### Passwords

```ts
import { assessWalletPassword, WALLET_PASSWORD_MIN_LENGTH } from '@cancore/wallet';

assessWalletPassword(password);
// null | 'empty' | 'too-short' | 'single-class' | 'common' | 'repeated' | 'sequence'
```

A code, not a sentence — you write the message in your language. The minimum is 12 characters,
and the reason it is not 8 is that this password is the *entire* at-rest defence: there is no
server to rate-limit an attacker who has the file.

### Errors

| Error | Means |
| --- | --- |
| `WrongPasswordError` | the AES-GCM tag did not verify — wrong password **or** a corrupted record, deliberately indistinguishable |
| `InvalidPrivateKeyError` | the seed is not 32 bytes of hex |
| `KeyBindingError` | the record decrypted, but the seed inside does not produce the public key on the record |

## Canton identity

```ts
cantonFingerprint(publicKeyHex);        // "1220…" multihash of the key
partyNamespace(partyId);                // the fingerprint half of "hint::namespace"
keyOwnsParty(publicKeyHex, partyId);    // does this key own that party?
```

## Signing

```ts
const signer = await createEd25519Signer(seed);
const signature = await signWithEd25519Signer(signer, message);
await verifyEd25519(publicKey, signature, message);
```

`createEd25519Signer` prefers a **non-extractable** WebCrypto `CryptoKey` and falls back to
`@noble/curves` when the runtime has no working Ed25519 in `subtle`. The choice is on the
value (`signer.kind` is `'subtle'` or `'noble'`), so a build that cannot accept a seed living
in JS memory can refuse it — see **Threat model**.

`createPasskeySigningProvider(signer, publicKeyHex)` wraps a signer in the shape the Cancore
app's provider slot expects, with two narrow methods that refuse anything but their own
message shape: `signChallenge` takes a printable-ASCII login challenge carrying
`LOGIN_CHALLENGE_PREFIX`, `signPreparedHash` takes a base64 prepared-transaction hash that is
exactly 32 bytes. A prepared hash can never satisfy the first, so a login signature cannot be
coaxed out of a transaction payload — or the reverse.

## `@cancore/wallet/operations` — the envelope client

Every state-changing Cancore operation goes through one envelope: **prepare → sign every leg →
submit**.

```ts
import { configureWalletOperations } from '@cancore/wallet/operations';

const wallet = configureWalletOperations(async (endpoint, init) => {
  const res = await fetch(`${API}${endpoint}`, { ...init, headers: authHeaders });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
});

const result = await wallet.execute(signer, 'transfer', { receiverPartyId, amount: '1.5' });
```

| Method | What it does |
| --- | --- |
| `list()` | the catalogue: every operation this wallet serves, with its params and flags |
| `prepare(type, params)` | `{ operationId, legs, meta }` |
| `submit(operationId, signatures)` | the outcome |
| `execute(signer, type, params, confirm?)` | the whole ceremony in one call |

Three facts that are expensive to learn from the outside:

1. **A signature is addressed by `legId`, never by position.** One user action can prepare
   several legs — a CC send prepares the transfer *and* its network fee — and the order is not
   yours to assume.
2. **`legs: []` is a legal success.** An operation with nothing left to do (a preapproval that
   already exists, a wallet with nothing to consolidate) says so in `meta`. Those are exactly
   the operations `execute` refuses to handle for you: read `meta` and decide, then `submit`.
3. **`confirm` runs after prepare and before any signature.** It receives the legs and the
   meta, and returning `false` raises `OperationDeclinedError` without a single signature
   being made. Omit it and `execute` behaves as it always did.

`signLegs(signer, legs, options?)` signs by hand when you are composing the steps yourself.
`pauseMsBetweenLegs` exists for signers that open a UI per signature — an extension asked
twice in the same tick can drop the second prompt — and is 0 for an unlocked local key.

## `@cancore/wallet/web` — the browser entry

```ts
import {
  putPersistedWallet, getPersistedWallet, clearPersistedWallet,
  listWalletAccounts, putWalletAccount, deleteWalletAccount,
  isWebAuthnSupported, registerPasskey, evalPrf,
} from '@cancore/wallet/web';
```

An IndexedDB-backed store for wallet records and a per-account list, plus the two WebAuthn
ceremonies. `evalPrf` returns **key-encryption material**, not a signature: a passkey unlocks
a record here, it does not sign for the ledger. Pair it with `deriveWrappingKey` and
`wrapSeed`/`unwrapSeed`.

This entry is the only part of the package that touches browser globals, which is why it is a
separate entry rather than a re-export: a CLI or an MCP server importing the core never pulls
`indexedDB` or `navigator.credentials` into its bundle.

## Threat model

**What holds.** Nothing key-shaped is persisted in the clear. Both KEK derivations ask
WebCrypto for a **non-extractable** key. A wrong password is indistinguishable from a
corrupted record by design. Records carry a format version, so a format change is a migration
rather than a lost wallet. Every ciphertext is bound by AAD to its record and its role.

The assumption to carry away: **the at-rest security of a record equals the strength of the
password that wrapped it.** Nothing here raises that ceiling.

### What this does not protect against

**XSS on your origin.** The password protects the record at rest, not a live session. After
unlock a signer sits in memory for as long as the tab does, and any script on your origin can
use it — this package cannot tell your code from injected code. The mitigation is a
`script-src` Content Security Policy on the page that embeds the wallet, and it belongs to
whoever serves that page: a page that embeds this wallet with no script policy has no at-rest
story worth the name. Cancore's own deployment serves that policy in report-only mode today.

**The `@noble` fallback holds the seed in JS.** Rare in a current browser, normal in a
headless runtime. The choice is observable, so a build that cannot accept it can refuse:

```ts
const signer = await createEd25519Signer(seed);
if (signer.kind !== 'subtle') { /* refuse the pure-JS path */ }
```

**The same crypto exists twice in the Cancore app.** `src/lib/safeKeystore.ts` implements the
same PBKDF2-600k + AES-GCM-256 independently for the operator's Safe key export, and still
reads `cancore-safe-ed25519-key`, the plaintext backup format that predates it, migrating it
on load. That legacy reader is removed in the first release after this package is published to
npm, and unconditionally on **2026-12-31**, whichever comes first.

## Testing against it

`MemoryKeyStore` implements the `KeyStore` contract in memory. `BuildOpts.now` is an
injectable clock, and `BuildOpts.iterations` lets a test wrap a record at 1 000 iterations
instead of 600 000 — do not ship that.

## Full documentation

**<https://docs.cancore.io/sdk/wallet>** — the same material with the reasoning behind each
decision, plus the operations catalogue.

## License

Apache-2.0.
