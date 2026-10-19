import { createSelfCustody, DEFAULT_VENUES, SettleError, networkOf, type DvpNetwork, type ServeHandle, type SessionOptions } from '@cancore/client/selfcustody';
import { dec, fmt, mul, SCALE } from '../decimal';
import { guardSigning } from '../verify';
import type { BotSigner, Engine, EngineHooks } from '../types';

// Daemon-layer additions to the core engine types.
declare module '../types' {
  interface OrderInfo {
    /** Set once the order has a taker: whether it is this account. */
    takenBySelf?: boolean;
  }
  interface Engine {
    /** Forget a take the venue shows was never accepted (see ServeHandle.forget). */
    /** False while serve is still working on the order: nothing is forgotten then. */
    forget?(orderId: string): boolean;
  }
  interface BotState {
    /** Taken bookings whose order read open with no taker: when that was first seen (ms). */
    takeOpenSeen?: Record<string, number>;
    /** Takes released as never accepted, kept for a day in case the accept lands late: booked once if it does. */
    releasedTakes?: Record<string, BotState['openOrders'][number] & { releasedAt: number }>;
    /** Orders whose fill was booked, with when (ms), for a day: a repeated settle is not an unknown one. */
    settledOrders?: Record<string, number>;
  }
  interface EngineHooks {
    /** A take or settle step of the loop failed; `errorName` is the error's class, never its text. */
    onTakeFailed?(orderId: string, errorName: string): void;
  }
}

export interface EngineOptions {
  signer: BotSigner;
  /** Gateway root, e.g. https://api.cancore.io */
  baseUrl: string;
  hooks: EngineHooks;
  /** Pinned from the owner's config: the API cannot move these (trust boundary). */
  venuePartyId?: string;
  maxFeeRate?: string;
  feeRecipientPartyId?: string | string[];
  network?: DvpNetwork;
  /** Ceiling of one withdraw's network fee, in CC; without it the SDK refuses every withdraw. */
  maxFee?: string;
  /** Injected for tests; defaults to globalThis.fetch. */
  fetchImpl?: SessionOptions['fetchImpl'];
  /** Settlement loop poll intervals; injected for tests. */
  pollMs?: number;
  reconcileMs?: number;
}

/** A self-custody account over `@cancore/client`, every signature through the verifying signer. */
/** Where an intent may have landed: an order created this long before or after it was recorded. */
const INTENT_WINDOW_MS = 10 * 60_000;

/** A call with no answer by then is given up (an order make becomes unconfirmed), so no tick hangs forever. */
const FETCH_TIMEOUT_MS = 20_000;

/** The client key as it rides on the order. */
export const intentTag = (key: string) => `cancore-botd:${key}`;

/** The venue the config pins, or the SDK's for the network; undefined when neither is known. */
export function pinnedVenue(options: Pick<EngineOptions, 'venuePartyId' | 'network' | 'baseUrl'>): string | undefined {
  const network = options.network ?? networkOf(options.baseUrl);
  return options.venuePartyId ?? (network ? DEFAULT_VENUES[network] : undefined);
}

/** What the maker gives and gets for an order of ours. */
function legs({ base, quote, side, amount, price }: { base: string; quote: string; side: 'buy' | 'sell'; amount: string; price: string }) {
  const [a, p] = [dec(amount), dec(price)];
  // The maker gives base for quote when selling, quote for base when buying; the bot never pays more than amount × price.
  return side === 'sell'
    ? { give: base, giveAmount: amount, get: quote, getAmount: fmt(mul(a, p, 'down')) }
    : { give: quote, giveAmount: fmt(mul(a, p, 'up')), get: base, getAmount: amount };
}

export function createEngine(options: EngineOptions): Engine {
  const { hooks } = options;
  // A venue taken from the API's fee-config would let the API pick who settles: pinned, or no engine.
  const venuePartyId = pinnedVenue(options);
  if (!venuePartyId) throw new Error(`no venue is pinned for ${options.baseUrl}: set venuePartyId (or network) in the config`);
  const guarded = guardSigning(options.signer, options.fetchImpl ?? ((url, init) => globalThis.fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS) })), hooks.onVerifyFailed);
  const acct = createSelfCustody({
    baseUrl: options.baseUrl,
    signer: guarded.signer,
    fetchImpl: guarded.fetchImpl,
    venuePartyId,
    ...(options.maxFeeRate && { maxFeeRate: options.maxFeeRate }),
    ...(options.feeRecipientPartyId && { feeRecipientPartyId: options.feeRecipientPartyId }),
    ...(options.network && { network: options.network }),
    ...(options.maxFee && { maxFee: options.maxFee }),
    ...(options.pollMs && { pollMs: options.pollMs }),
  });
  let loop: ServeHandle | undefined;

  // This account's user id, cached after the first order that needs it.
  let selfId: string | undefined;
  const engine: Engine = {
    async make({ ttlSeconds, clientKey, ...params }) {
      const { give, giveAmount, get, getAmount } = legs(params);
      const order = await acct.swap.create({
        sourceNetwork: 'canton', sourceTokenAddress: give, sourceTokenName: give, sourceAmount: giveAmount,
        targetNetwork: 'canton', targetTokenAddress: get, targetTokenName: get, targetAmount: getAmount,
        dvp: true,
        description: intentTag(clientKey),
        ...(ttlSeconds && { expirationHours: Math.max(1, Math.ceil(ttlSeconds / 3600)) }),
      }).catch((err: unknown) => {
        // A DvP refusal (4xx) comes back as a SettleError without a swap and without the status: still a "no".
        throw err instanceof SettleError && err.swapId === null ? Object.assign(new Error(err.message), { status: 400 }) : err;
      });
      return { orderId: order.id };
    },
    async findIntent(intent, known) {
      const [base = '', quote = ''] = intent.pair.split('/');
      const { give, giveAmount, get, getAmount } = legs({ base, quote, side: intent.side, amount: intent.amount, price: intent.price });
      // shortcut: one page of 100 in the API's default order, newest first (createdAt DESC; the client exposes no
      // created-at sortBy), so an intent's order beyond the 100 newest is dropped, not found; page through if bots
      // ever hold that many orders.
      const { items } = await acct.swap.listMine({ pageSize: 100, statusFilter: 'all' });
      const mine = items.filter((o) => !known.includes(o.id));
      const tagged = mine.find((o) => o.description === intentTag(intent.key));
      if (tagged) return tagged.id;
      // The API may rewrite the description (a cancel reason): fall back to the same order, made around the same time.
      const same = mine.find((o) => {
        const at = Date.parse(o.createdAt);
        return o.sourceTokenAddress === give && o.targetTokenAddress === get
          && dec(o.sourceAmount) === dec(giveAmount) && dec(o.targetAmount) === dec(getAmount)
          && Math.abs(at - intent.at) <= INTENT_WINDOW_MS;
      });
      return same?.id;
    },
    async quote({ base, quote, side, amount }) {
      // The pool quotes what you give: base when selling, quote when buying.
      const [source, target] = side === 'sell' ? [base, quote] : [quote, base];
      const pair = (await acct.swap.pairs()).find((p) => p.sourceToken === source && p.targetToken === target);
      if (!pair) throw new Error(`no pool quotes ${source}/${target}`);
      // shortcut: a buy's quote amount is estimated from the market rate, so the base it returns is close to `amount`, not exact.
      const sourceAmount = side === 'sell' ? amount : pair.marketRate ? fmt((dec(amount) * SCALE) / dec(pair.marketRate)) : undefined;
      if (sourceAmount === undefined) throw new Error(`no market rate for ${source}/${target}`);
      const q = await acct.swap.quote({ pairConfigId: pair.id, sourceAmount });
      const [baseAmount, quoteAmount] = side === 'sell' ? [q.sourceAmount, q.targetAmount] : [q.targetAmount, q.sourceAmount];
      return {
        base, quote, side, amount: fmt(dec(baseAmount)), total: fmt(dec(quoteAmount)),
        price: fmt((dec(quoteAmount) * SCALE) / dec(baseAmount)), expiresInSec: q.expiresInSec,
      };
    },
    async register(inviteCode) {
      try {
        await acct.session.register(inviteCode ? { inviteCode } : {});
      } catch (err) {
        // Already registered: the key signs in, and onboarding is safe to repeat.
        if ((err as { status?: number }).status !== 409) throw err;
      }
      return engine.onboard();
    },
    async onboard() {
      const { partyId } = await acct.onboard();
      if (!partyId) throw new Error('onboarding finished without a party');
      return partyId;
    },
    async take({ orderId }) {
      engine.start();
      loop!.take(orderId);
      return { orderId, filled: '0' };
    },
    untake(orderId) {
      return loop ? loop.untake(orderId) : true;
    },
    forget(orderId) {
      return loop ? loop.forget(orderId) : true;
    },
    async cancel(orderId) {
      await acct.swap.cancel(orderId);
    },
    async order(orderId) {
      const o = await acct.swap.get(orderId);
      // Who took it: this account, another one, or not known (no opponent yet). Our id is asked once, and only when needed.
      if (o.opponentUserId && selfId === undefined) selfId = (await acct.me()).id;
      const takenBySelf = o.opponentUserId ? o.opponentUserId === selfId : undefined;
      return { orderId: o.id, status: o.status, source: o.sourceTokenAddress, sourceAmount: o.sourceAmount, target: o.targetTokenAddress, targetAmount: o.targetAmount, ...(takenBySelf !== undefined && { takenBySelf }) };
    },
    async balances(instruments) {
      return Promise.all(instruments.map(async (instrument) => ({ instrument, amount: (await acct.balance(instrument)).balance })));
    },
    async referencePrices() {
      const prices: Record<string, string> = {};
      for (const pair of await acct.swap.pairs()) {
        if (!pair.marketRate) continue;
        try {
          const rate = dec(pair.marketRate);
          if (rate <= 0n) continue;
          prices[`${pair.sourceToken}/${pair.targetToken}`] = fmt(rate);
          prices[`${pair.targetToken}/${pair.sourceToken}`] = fmt((SCALE * SCALE) / rate);
        } catch {
          // A rate with more than 10 decimals is not one the gate can compare exactly: no reference, so no trade.
        }
      }
      return prices;
    },
    async usdPrices() {
      const prices: Record<string, string> = {};
      // sourcePriceUsd is the API's USD price of the pair's source token; a token that is only ever a target is
      // valued through the mid-market rate (USD per source / target per source). Own prices win over derived ones.
      const derived: Record<string, string> = {};
      for (const pair of await acct.swap.pairs()) {
        if (!pair.sourcePriceUsd) continue;
        try {
          const usd = dec(pair.sourcePriceUsd);
          if (usd <= 0n) continue;
          prices[pair.sourceToken] = fmt(usd);
          const rate = pair.marketRate ? dec(pair.marketRate) : 0n;
          if (rate > 0n) {
            // Conservative for the caps: round up, and of several pairs pricing one token take the highest.
            const v = (usd * SCALE + rate - 1n) / rate;
            const prev = derived[pair.targetToken];
            if (prev === undefined || v > dec(prev)) derived[pair.targetToken] = fmt(v);
          }
        } catch {
          // Not an exact decimal: no USD price, so the gate refuses rather than guesses.
        }
      }
      return { ...derived, ...prices };
    },
    async withdraw(to, instrument, amount) {
      await acct.send({ receiverPartyId: to, amount, ...(instrument !== 'CC' && { tokenId: instrument }) });
    },
    start() {
      loop ??= acct.serve({
        autoWithdraw: true,
        ...(options.reconcileMs && { reconcileMs: options.reconcileMs }),
        onEvent: (event) => {
          if (event.type === 'settled') hooks.onSettled(event.orderId);
          else if (event.type === 'expired') hooks.onEnded(event.orderId, 'expired');
          // The error's class only: its message may carry text from the API.
          else if (event.type === 'error' && event.orderId) hooks.onTakeFailed?.(event.orderId, (event.error as Error)?.name ?? 'Error');
        },
      });
    },
    async stop() {
      const running = loop;
      loop = undefined;
      await running?.stop();
    },
  };
  return engine;
}
