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
 * A topology multihash is signed through `signMessage`, not here: the daemon never onboards.
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

/**
 * Wraps the engine's `fetch` and signer together: the fetch records which hashes were recomputed
 * from bytes, the signer signs only those (each once). `onFailed` hears every mismatch and every
 * refused signature.
 */
export function guardSigning(inner: BotSigner, fetchImpl: FetchLike, onFailed: (reason: string) => void): { signer: BotSigner; fetchImpl: FetchLike } {
  const verified = new Set<string>();

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
      if (real === hash) verified.add(hash);
      else onFailed(`prepared transaction hash ${hash} is not the hash of its bytes (${real ?? 'undecodable'})`);
    }
    return res;
  };

  const signer: BotSigner = {
    public_key: inner.public_key,
    // Text only (consent, faucet terms): raw bytes here would be a prepared-transaction hash signed past the check below.
    async signMessage(m) {
      if (!/^[\x20-\x7e\n]*$/.test(m)) {
        const reason = 'refused to sign a non-text message: hashes are signed only through signPreparedHash';
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
  return { signer, fetchImpl: guardedFetch };
}
