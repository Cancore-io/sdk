import { AsyncLocalStorage } from 'async_hooks';
import type { SessionOptions } from '@cancore/client/selfcustody';
import { decodePreparedTransaction, hashPreparedTransactionV2 } from '@cancore/trader/filler/canton/hashing';
import type { BotSigner } from './types';

type FetchLike = NonNullable<SessionOptions['fetchImpl']>;

/**
 * The daemon's own check under the SDK's: a prepared-transaction hash is signed only if this
 * process saw the transaction's bytes come back from the API and recomputed exactly that hash
 * from them (hashing scheme V2, `@cancore/trader`'s port, independent of the SDK's library).
 *
 * The SDK already reads every DvP and token ceremony before it signs (`verifyDvpPrepared`,
 * `verifySendPrepared` …): that checks WHAT the transaction does. This checks that the hash is OF
 * those bytes, at the one choke point every signature passes — the signer — so no code path,
 * an `allowUnverified` flag or a future SDK route included, can sign a hash nobody recomputed.
 *
 * A topology multihash is signed through `signMessage`, not here: the wallet's topology leg carries the
 * 34-byte multihash and not the transactions it is of, so there are no bytes to recompute it from. The
 * daemon does onboard (`register`, the first unlock), and a new key's party exists only once the key has
 * signed its topology (CAN-2922): so `signMessage` signs one multihash per `onboarding()` call, while it
 * runs, and none anywhere else.
 */
export class VerifyError extends Error {
  constructor(reason: string) {
    super(`verify_failed: ${reason}`);
    this.name = 'VerifyError';
  }
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/** Every `{ preparedTransaction, preparedTransactionHash | hash }` pair anywhere in an API answer. */
function* preparedPairs(v: unknown): Generator<{ bytes: string; hash: string }> {
  if (Array.isArray(v)) for (const x of v) yield* preparedPairs(x);
  else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const hash = o.preparedTransactionHash ?? o.hash;
    if (typeof o.preparedTransaction === 'string' && typeof hash === 'string') yield { bytes: o.preparedTransaction, hash };
    for (const x of Object.values(o)) yield* preparedPairs(x);
  }
}

/** The hash a prepared transaction's bytes really have, base64; undefined if they do not decode. */
export function recomputeHash(preparedTransaction: string): string | undefined {
  try {
    return b64(hashPreparedTransactionV2(decodePreparedTransaction(preparedTransaction)));
  } catch {
    return undefined;
  }
}

/** A sha2-256 multihash, `0x12 0x20` and 32 bytes, as the binary string the wallet signs a topology leg with. */
const isTopologyMultihash = (m: string) => m.length === 34 && m.startsWith('\x12\x20') && /^[\x00-\xff]*$/.test(m);

type Onboarding = <T>(onboard: () => Promise<T>) => Promise<T>;

/**
 * Wraps the engine's `fetch` and signer together: the fetch records which hashes were recomputed
 * from bytes, the signer signs only those (each once). `onFailed` hears every mismatch and every
 * refused signature. `onboarding` runs an onboarding, the one place a topology multihash is signed.
 */
const MAX_VERIFIED = 256;

export function guardSigning(inner: BotSigner, fetchImpl: FetchLike, onFailed: (reason: string) => void): { signer: BotSigner; fetchImpl: FetchLike; onboarding: Onboarding } {
  const verified = new Set<string>();
  // Bound to the onboarding's own async calls, not to a time window: a trade signing meanwhile gets no multihash.
  const topologyWindow = new AsyncLocalStorage<{ open: boolean }>();
  const takeTopologySignature = () => {
    const slot = topologyWindow.getStore();
    if (!slot?.open) return false;
    slot.open = false;
    return true;
  };
  const onboarding: Onboarding = async (onboard) => {
    const slot = { open: true };
    try {
      return await topologyWindow.run(slot, onboard);
    } finally {
      // Whatever the onboarding left scheduled inherits its slot: closed with it.
      slot.open = false;
    }
  };

  const guardedFetch: FetchLike = async (url, init) => {
    const res = await fetchImpl(url, init);
    let body: unknown;
    try {
      body = await res.clone().json();
    } catch {
      return res;
    }
    for (const { bytes, hash } of preparedPairs(body)) {
      const real = recomputeHash(bytes);
      if (real === hash) {
        verified.add(hash);
        // Abandoned prepares never get signed: keep only the newest MAX_VERIFIED (a Set iterates oldest first).
        if (verified.size > MAX_VERIFIED) verified.delete(verified.values().next().value!);
      }
      else onFailed(`prepared transaction hash ${hash} is not the hash of its bytes (${real ?? 'undecodable'})`);
    }
    return res;
  };

  const signer: BotSigner = {
    public_key: inner.public_key,
    // Text only (consent, faucet terms), and one topology multihash per onboarding: raw bytes here would be a
    // prepared-transaction hash signed past the check below.
    async signMessage(m) {
      if (!/^[\x20-\x7e\n]*$/.test(m) && !(isTopologyMultihash(m) && takeTopologySignature())) {
        const reason = 'refused to sign a non-text message: hashes are signed only through signPreparedHash, a topology multihash once per onboarding';
        onFailed(reason);
        throw new VerifyError(reason);
      }
      return inner.signMessage(m);
    },
    ...(inner.signChallenge && { signChallenge: (c: string) => inner.signChallenge!(c) }),
    async signPreparedHash(hash) {
      if (!verified.delete(hash)) {
        const reason = `refused to sign ${hash}: no transaction bytes with this hash were seen`;
        onFailed(reason);
        throw new VerifyError(reason);
      }
      return inner.signPreparedHash(hash);
    },
    destroy: () => {
      verified.clear();
      inner.destroy();
    },
  };
  Object.defineProperty(signer, 'toJSON', { value: () => ({ public_key: signer.public_key }) });
  return { signer, fetchImpl: guardedFetch, onboarding };
}
