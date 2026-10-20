import { CancoreApiError } from './http';
import type { SdkErrorCode } from './sdk-error-codes';

/** What the self-custody account does about a refusal; `other` is "surface it". */
export type Refusal =
  | 'retrySameSignatures'
  | 'rerunCeremony'
  | 'mergeThenRetry'
  | 'counterNotReady'
  | 'counterAlreadyAccepted'
  | 'alreadySettled'
  | 'redeemInviteSeparately'
  | 'retrySignIn'
  | 'dvpNotAllowed'
  | 'feeHoldingRequired'
  | 'accountStopped'
  | 'other';

function assertNever(value: never): never {
  throw new Error(`Unhandled SdkErrorCode: ${String(value)}`);
}

/**
 * Every code is named, so a code the refresh adds fails `tsc` here until someone
 * decides what a program does about it.
 */
export function refusalForCode(code: SdkErrorCode): Refusal {
  switch (code) {
    /** The prepared submission timed out and may still commit: resubmitting the same signatures is deduplicated. */
    case 'SUBMISSION_TIMEOUT_RETRYABLE':
      return 'retrySameSignatures';
    /** The one-shot prepare stash was gone when the submit arrived: nothing committed, the whole ceremony may run again. */
    case 'PREPARED_SUBMISSION_EXPIRED':
      return 'rerunCeremony';
    case 'WALLET_TOO_FRAGMENTED':
      return 'mergeThenRetry';
    case 'COUNTER_PROPOSAL_NOT_READY':
      return 'counterNotReady';
    case 'COUNTER_PROPOSAL_ALREADY_ACCEPTED':
      return 'counterAlreadyAccepted';
    case 'SWAP_ALREADY_SETTLED':
      return 'alreadySettled';
    /** At sign-in, possibly a key the gateway knows but answered too slowly for (see `login` in session.ts). */
    case 'ACCOUNT_NOT_FOUND':
      return 'retrySignIn';
    /** The stand has not opened allocation-DvP to this account: a Canton↔Canton trade cannot settle, and is never moved to HTLC. */
    case 'DVP_NOT_ALLOWED':
      return 'dvpNotAllowed';
    /** The DvP fee leg needs a holding of its own on the paying (taker) side: that side splits its balance, then the trade is retried. */
    case 'DVP_FEE_HOLDING_REQUIRED':
      return 'feeHoldingRequired';
    /** The owner stopped this bot account: no order is made or taken until the owner resumes it, so a retry before that cannot succeed. */
    case 'ACCOUNT_STOPPED':
      return 'accountStopped';
    // Too little balance even with a fee holding of its own: another split would not help, so never feeHoldingRequired.
    case 'DVP_FEE_BALANCE_INSUFFICIENT':
    case 'REQUIRES_INTERACTIVE_SUBMISSION':
    case 'SWAP_FEE_PENDING':
    case 'SWAP_FEE_ALREADY_PAID':
    case 'SWAP_FEE_LEG_ALREADY_SUBMITTED':
    case 'SWAP_FEE_LEG_MISMATCH':
    case 'FEE_PAYMENT_ALREADY_USED':
    case 'FEE_PAYMENT_NOT_VERIFIED':
    case 'CC_PREAPPROVAL_REQUIRED':
    case 'MIGRATION_REQUIRED':
    case 'KEY_IN_USE':
    case 'NOT_ELIGIBLE':
    case 'DEFERRED_FEE_ALREADY_SETTLED':
    case 'DEFERRED_FEE_LEG_MISMATCH':
    case 'LP_WITHDRAW_FEE_LEG_MISMATCH':
    case 'LP_WITHDRAW_FEE_ALREADY_SUBMITTED':
    case 'WALLET_KEY_MISMATCH':
    case 'PARTY_HOSTING_UNKNOWN':
    case 'PARTY_NOT_HOSTED':
    case 'LOOP_ACCEPT_AWAITS_FINALIZE':
    case 'MAINTENANCE_MODE':
    case 'MIGRATED_USE_WALLET':
    case 'EMAIL_REGISTERED_AS_PASSWORD':
    case 'WALLET_MISMATCH':
    case 'SIGNING_METHOD_UNSUPPORTED':
    case 'NOT_FOUND':
    // The agent mandate (backend `/agent/mandate*` and the `mandate.*` wallet ceremonies). No flow of
    // this client runs those yet, so there is nothing for it to do about them but surface them.
    case 'NO_ACTIVE_MANDATE':
    case 'MANDATE_EXISTS':
    case 'MANDATE_AMBIGUOUS':
    case 'IDEMPOTENCY_KEY_REUSED':
    case 'MANDATE_NOT_YET_VISIBLE':
    case 'GEO_RESTRICTED':
    // The partner Temple desk, the intent routes and quotes, and filler registration: no flow of this
    // client runs them, so it only surfaces them.
    case 'TEMPLE_FORBIDDEN':
    case 'TEMPLE_NOT_ENABLED':
    case 'TEMPLE_NO_PARTY':
    case 'TEMPLE_LIMITS_NOT_SET':
    case 'TEMPLE_PAIR_NOT_ALLOWED':
    case 'TEMPLE_BELOW_MINIMUM':
    case 'TEMPLE_PER_TRADE_LIMIT':
    case 'TEMPLE_DAILY_LIMIT':
    case 'TEMPLE_DESK_BUSY':
    case 'TEMPLE_DESK_NOT_CONFIGURED':
    case 'TEMPLE_PRICE_UNAVAILABLE':
    case 'TEMPLE_QUOTE_UNAVAILABLE':
    case 'ROUTE_CATALOG_INVALID':
    case 'ROUTE_VERSION_CONFLICT':
    case 'ROUTE_CHECK_FAILED':
    case 'ROUTE_CHANGE_NOT_PENDING':
    case 'ROUTE_CHANGE_SUPERSEDED':
    case 'ROUTE_CHANGE_OWN':
    case 'ROUTE_NOT_SUPPORTED':
    case 'RECIPIENT_NOT_READY':
    case 'PRICE_UNAVAILABLE':
    case 'OFFER_EXPIRED':
    case 'FILLER_UNAVAILABLE':
    case 'INVALID_QUOTE_REQUEST':
    case 'FORBIDDEN':
    case 'WALLET_NOT_LINKED':
    case 'BELOW_MIN_INPUT':
    case 'OPEN_PAUSED':
    case 'ROUTE_PAUSED':
    case 'DESTINATION_NOT_REGISTERED':
    case 'INSUFFICIENT_BALANCE':
    case 'NOT_OWNER':
    // An intent's, not a swap's: never alreadySettled, which is about an HTLC swap both sides claimed.
    case 'ALREADY_SETTLED':
    case 'REFUND_NOT_YET':
    case 'CANCEL_NOT_ALLOWED':
    case 'APPLICATION_EXISTS':
    case 'ALREADY_FILLER':
    case 'PARTNER_EXISTS':
    case 'NO_APPLICATION':
    case 'NOT_EDITABLE':
    case 'BAD_IMAGE':
    case 'FILLER_ID_TAKEN':
    case 'FILLER_ID_INVALID':
    case 'DISPLAY_NAME_TAKEN':
    case 'BAD_KEY_REGISTRATION':
    case 'KEY_CHANGE_PENDING':
    case 'BAD_TEXT':
    case 'ROUTE_CHANGE_PENDING':
    case 'REQUEST_CLOSED':
    case 'CANTON_PARTY_REQUIRED':
    case 'CANTON_PARTY_INVALID':
    case 'CANTON_PARTY_TAKEN':
    case 'ROUTE_INVALID':
    case 'LIMITS_INVALID':
    case 'BAD_CURSOR':
    case 'NOT_A_FILLER':
    case 'NOT_REVIEWABLE':
    case 'ALREADY_IN_STATE':
    case 'NOT_READY':
    case 'KEY_CHECK_UNAVAILABLE':
    case 'PARTY_CHECK_UNAVAILABLE':
    case 'REGISTRY_UNCONFIGURED':
    case 'REGISTRY_CONFLICT':
    case 'REGISTRY_STATE':
    case 'REGISTRY_IN_USE':
    case 'FILLER_ACTIVE':
    case 'ATTESTOR_KEY':
    case 'ATTESTOR_LIST_MISSING':
    case 'REGISTRATION_LINK_INVALID':
    case 'REGISTRATION_LINKS_BUSY':
      return 'other';
    default:
      return assertNever(code);
  }
}

/*
 * ponytail: prose fallback, only for a body with no code this client knows (none,
 * or one from a newer gateway). Dev serves a code for all six; mainnet does not
 * until those ship there, and names the conditions only in its message. Drop the
 * message fallback once mainnet serves the codes — and the invite rule with it,
 * once mainnet's sign-up takes `inviteCode`.
 */
function refusalFromProse(err: CancoreApiError): Refusal {
  const says = (status: number, text: string) => err.status === status && JSON.stringify(err.body ?? '').includes(text);
  if (says(400, 'safe to retry')) return 'retrySameSignatures';
  if (says(400, 'No pending')) return 'rerunCeremony';
  if (says(409, 'Wallet too fragmented')) return 'mergeThenRetry';
  if (says(400, 'Counter proposal not found')) return 'counterNotReady';
  if (says(400, 'Counter proposal already accepted')) return 'counterAlreadyAccepted';
  if (says(400, 'both_claimed')) return 'alreadySettled';
  if (says(409, 'needs a holding of its own') || says(409, 'separate holding for the platform fee')) return 'feeHoldingRequired';
  // The DvP door's own words (backend DVP_FORBIDDEN_MESSAGE). A 403 that says anything else is not
  // this refusal: self-trade, documents not accepted and a stopped bot account are 403 as well.
  if (says(403, 'Allocation-DvP is not open')) return 'dvpNotAllowed';
  // A sign-up DTO without the field: the whitelisting validation pipe names it.
  if (says(400, 'property inviteCode should not exist')) return 'redeemInviteSeparately';
  return 'other';
}

/**
 * Code first; the text of the message only when the body carries no code this
 * client knows — none (an older gateway), or one it does not (a newer gateway).
 */
export function refusalOf(err: unknown): Refusal {
  if (!(err instanceof CancoreApiError)) return 'other';
  return err.errorCode === undefined ? refusalFromProse(err) : refusalForCode(err.errorCode);
}
