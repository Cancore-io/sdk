import { deriveWalletKey, type DerivedWalletKey } from './mnemonic';
import { cantonFingerprint, partyNamespace } from './cantonFingerprint';

/**
 * Dual-scheme restore resolution (CAN-539): a recovery phrase may belong to a
 * wallet created on the standard BIP44 path or to a pre-BIP44 wallet on the
 * legacy master-key scheme. Restore flows derive both candidates and pick the
 * one whose key actually exists, so old phrases keep restoring the right party
 * while everything new lands on the standard path.
 */

export type DerivedCandidate = DerivedWalletKey;

/** Both derivations of a phrase, standard first — the restore priority order. */
export function deriveCandidates(mnemonic: string): DerivedCandidate[] {
  return (['standard', 'legacy'] as const).map((scheme) => deriveWalletKey(mnemonic, scheme));
}

/**
 * Pick the candidate whose account exists, probing in priority order (standard
 * wins when both would match). Returns null when no derivation matches. Probe
 * errors propagate — a network failure must not be mistaken for "no account".
 */
export async function resolveRestoredSeed(
  mnemonic: string,
  accountExists: (publicKeyHex: string) => Promise<boolean>,
): Promise<DerivedCandidate | null> {
  for (const candidate of deriveCandidates(mnemonic)) {
    if (await accountExists(candidate.publicKeyHex)) return candidate;
  }
  return null;
}

export interface PhraseMatch {
  /** The derivation whose key owns the party, or null when neither does. */
  matched: DerivedCandidate | null;
  /** Fingerprint the party's namespace demands. */
  expectedFingerprint: string;
  /** What each derivation of this phrase actually produces — shown when nothing matches. */
  attempted: Array<{ scheme: DerivedCandidate['scheme']; fingerprint: string }>;
}

/**
 * Decide, offline, whether a recovery phrase is the one that controls `partyId`.
 *
 * A party id carries its key's fingerprint after `::`, so this needs no network
 * call and no submission: derive the phrase both ways (a wallet created before
 * the BIP44 switch is on the legacy scheme — see {@link deriveCandidates}) and
 * compare. That turns "publicKey does not match the key already registered",
 * which a user can neither verify nor act on, into a verdict they can read
 * before pressing anything: this phrase opens THAT wallet, the migration wants
 * THIS one (BUG-321).
 */
export function matchPhraseToParty(mnemonic: string, partyId: string): PhraseMatch {
  const expectedFingerprint = partyNamespace(partyId) ?? '';
  const attempted = deriveCandidates(mnemonic).map((candidate) => ({
    candidate,
    fingerprint: cantonFingerprint(candidate.publicKeyHex),
  }));
  const hit = attempted.find((a) => a.fingerprint === expectedFingerprint && expectedFingerprint !== '');
  return {
    matched: hit?.candidate ?? null,
    expectedFingerprint,
    attempted: attempted.map((a) => ({ scheme: a.candidate.scheme, fingerprint: a.fingerprint })),
  };
}

/**
 * "No account for this key" as reported by the auth challenge endpoint, as
 * opposed to infrastructure failures. Mirrors the classification the login
 * error handler has always used for restore-time challenge errors.
 *
 * BUG-651: previously also matched the bare word "challenge", so ordinary
 * infra failures ("Timeout waiting for challenge response") were misread as
 * "no account". This is the single predicate — `src/hooks/auth/restore.ts`
 * re-uses it instead of keeping its own copy of the regex.
 *
 * BUG-651 PR review (Mike): the non-JSON-body fallback in
 * canton-signing.service.ts's requestChallenge builds `Challenge request
 * failed: ${response.statusText}` — a 401 with no JSON body reads
 * "Unauthorized", not "401", so the predicate must match the status TEXT too,
 * not just a bare numeric code, or that response falls through to `failed`
 * instead of `no-account-match` and breaks the dual-scheme restore probe
 * (CAN-539) that expects a definite true/false, not an exception.
 */
export function isNoAccountError(message: string): boolean {
  // `account_not_found` is unreachable today — the frontend only ever reads
  // errorData.message, and the backend puts this code in errorCode instead —
  // kept for when the FE starts surfacing errorCode (BUG-651 G5 review).
  return /not found|no user|no account|account is linked|account_not_found|unauthorized|\b40[14]\b/i.test(
    message,
  );
}

/**
 * Turn the auth challenge request into an account-existence probe: a challenge
 * is only issued for registered keys, so success means the account exists and
 * a recognizable rejection means it does not. Anything else (network down,
 * 5xx) rethrows so the caller surfaces a real error instead of "wrong phrase".
 */
export function makeChallengeAccountProbe(
  requestChallenge: (publicKeyHex: string) => Promise<unknown>,
): (publicKeyHex: string) => Promise<boolean> {
  return async (publicKeyHex) => {
    try {
      await requestChallenge(publicKeyHex);
      return true;
    } catch (e) {
      if (e instanceof Error && isNoAccountError(e.message)) return false;
      throw e;
    }
  };
}
