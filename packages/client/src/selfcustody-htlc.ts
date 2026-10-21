import type { Http } from './http';
import { DEFAULT_ESCROWS, DEFAULT_VENUES, type DvpNetwork } from './dvp-admins';
import { verifyHtlcAcceptCounterPrepared, verifyHtlcFlowBPrepared, type HtlcPins } from './htlc-verify';
import type { PreparedToSign, TokenOperation } from './dvp-verify';
import type { Executed, HtlcSwap, SelfCustodyOptions, TokenCallOptions } from './selfcustody';

/** What `openHtlc` opens. */
export interface OpenHtlcInput extends TokenCallOptions {
  /** The API's token id (`CC` for Canton Coin). */
  tokenId: string;
  /** What the HTLC locks, as a decimal of at most ten places. */
  amount: string;
  receiver: string;
  /** Lowercase hex SHA-256 of the caller's preimage (`newPreimage()`). */
  hashLock: string;
  timeoutHours: number;
  orderId?: string;
  description?: string;
}

export interface OpenedHtlc {
  /** The swap the request opened. */
  swapId: string;
  result: unknown;
}

/** What the account expects of a counter leg before it accepts it. */
export interface CounterExpectation extends TokenCallOptions {
  amount: string;
  tokenId: string;
  /** The account's own hash lock: the counter must be locked to the same secret. */
  hashLock: string;
  /** Epoch ms: the counter must not time out before this. */
  minTimeout: number;
}

interface HtlcContext<TLeg> {
  http: Http;
  options: SelfCustodyOptions;
  network: DvpNetwork | undefined;
  feeRecipients: string[];
  trustedHtlc: Record<string, string[]>;
  maxFeeRate: string;
  now: () => number;
  instrumentOf: (tokenId?: string) => string;
  tokenAdmins: (instrument: string) => string[];
  feeCeiling: (operation: TokenOperation, call?: TokenCallOptions) => string;
  run: <TMeta>(type: string, params: Record<string, unknown> | undefined, rerunOnStalePrepare: boolean, check?: (legs: TLeg[], meta: TMeta | null) => Promise<void>) => Promise<Executed<TMeta>>;
  reading: (operation: TokenOperation, call: TokenCallOptions | undefined, verify: (legs: Array<PreparedToSign & { kind: string }>, pins: { dso: string[]; feeRecipients: string[] }, party: string) => Promise<void>) => (legs: TLeg[]) => Promise<void>;
}

/** Build the self-custody HTLC ceremonies (`openHtlc`, `acceptCounter`, `refund`) for an account. */
export function createHtlcActions<TLeg>(ctx: HtlcContext<TLeg>) {
  /** The parties and packages a self-custody HTLC may name on this account's network. */
  function htlcPins(): HtlcPins {
    const venue = ctx.options.venuePartyId ?? (ctx.network ? DEFAULT_VENUES[ctx.network] : undefined);
    const executors = venue ? [venue] : [];
    return {
      escrows: [...(ctx.network ? DEFAULT_ESCROWS[ctx.network] : []), ...[ctx.options.escrowPartyId ?? []].flat()],
      executors,
      feeParties: ctx.feeRecipients,
      providers: executors,
      packages: ctx.trustedHtlc,
    };
  }

  async function openHtlc(input: OpenHtlcInput): Promise<OpenedHtlc> {
    const { tokenId, amount, receiver, hashLock, timeoutHours, orderId, description } = input;
    const instrument = ctx.instrumentOf(tokenId);
    const maxFee = ctx.feeCeiling('htlc.flow-b-create', input);
    const params = { tokenId, amount: Number(amount), receiver, hashLock, timeoutHours, ...(orderId ? { orderId } : {}), ...(description ? { description } : {}) };
    const { meta, result } = await ctx.run<{ swapId?: string }>('htlc.flow-b-create', params, false,
      ctx.reading('htlc.flow-b-create', input, (legs, pins, party) => verifyHtlcFlowBPrepared(legs, {
        ...htlcPins(), party, receiver, amount, instrument, admins: ctx.tokenAdmins(instrument), hashLock, timeoutHours,
        maxFeeRate: ctx.maxFeeRate, now: ctx.now(), maxFee, feeRecipients: pins.feeRecipients, dso: pins.dso,
      })));
    return { swapId: String(meta?.swapId ?? ''), result };
  }

  const acceptCounter = (swapId: string, expect: CounterExpectation): Promise<Executed> => {
    const instrument = ctx.instrumentOf(expect.tokenId);
    return ctx.run('htlc.accept-counter', { swapId }, false, ctx.reading('htlc.accept-counter', expect, (legs, _pins, party) => verifyHtlcAcceptCounterPrepared(legs, {
      ...htlcPins(), party, amount: expect.amount, instrument, admins: ctx.tokenAdmins(instrument), hashLock: expect.hashLock, minTimeout: expect.minTimeout, now: ctx.now(),
    })));
  };

  const refund = (swapId: string) => ctx.http.post<HtlcSwap>(`/htlc/${encodeURIComponent(swapId)}/refund`);

  return { openHtlc, acceptCounter, refund };
}

export function randomHex(bytes: number): string {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The hash lock of a preimage: SHA-256 over its UTF-8 text, as the ledger computes it. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A fresh HTLC preimage: 32 random bytes as hex text, and its hash lock, the SHA-256 of that text. The SDK
 * keeps no copy of the preimage, so the caller must store it before the swap is made: a lost preimage means
 * the counter leg can never be claimed, and the swap ends in a refund.
 */
export async function newPreimage(): Promise<{ preimage: string; hashLock: string }> {
  const preimage = randomHex(32);
  return { preimage, hashLock: await sha256Hex(preimage) };
}

/**
 * Claim the counter HTLC of a swap with its preimage (`POST /htlc/:id/claim-counter`). The venue executes
 * the claim, so this call signs nothing, and it never logs or stores the preimage. The venue receives the
 * preimage, so this call trusts the venue not to use it on the other HTLC of the swap and not to leak it.
 * An empty preimage is refused before any request is made.
 */
export function postClaimCounter(http: Pick<Http, 'post'>, swapId: string, preimage: string): Promise<HtlcSwap> {
  if (preimage.length === 0) return Promise.reject(new Error('preimage must not be empty'));
  return http.post<HtlcSwap>(`/htlc/${encodeURIComponent(swapId)}/claim-counter`, { preimage });
}
