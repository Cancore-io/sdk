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
      return 'other';
    default:
      return assertNever(code);
  }
}

/*
 * ponytail: prose fallback, only for a body with no code this client knows (none,
 * or one from a newer gateway). Dev serves a code for all six (CAN-1955: backend
 * #1874/#1875/#1877/#1907); mainnet does not until those ship dev → stage → main,
 * and names the conditions only in its message. Drop the message fallback once
 * mainnet serves CAN-1955 codes — and the invite rule with it, once mainnet's
 * sign-up takes `inviteCode` (CAN-1593, backend #1846/#1888).
 */
function refusalFromProse(err: CancoreApiError): Refusal {
  const says = (status: number, text: string) => err.status === status && JSON.stringify(err.body ?? '').includes(text);
  if (says(400, 'safe to retry')) return 'retrySameSignatures';
  if (says(400, 'No pending')) return 'rerunCeremony';
  if (says(409, 'Wallet too fragmented')) return 'mergeThenRetry';
  if (says(400, 'Counter proposal not found')) return 'counterNotReady';
  if (says(400, 'Counter proposal already accepted')) return 'counterAlreadyAccepted';
  if (says(400, 'both_claimed')) return 'alreadySettled';
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
