import { createSelfCustody, DEFAULT_VENUES, networkOf, type DvpNetwork, type ServeHandle, type SessionOptions } from '@cancore/client/selfcustody';
import { dec, fmt, mul, SCALE } from '../decimal';
import { guardSigning } from '../verify';
import type { BotSigner, Engine, EngineHooks } from '../types';

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
  const guarded = guardSigning(options.signer, options.fetchImpl ?? ((url, init) => globalThis.fetch(url, init)), hooks.onVerifyFailed);
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

  const engine: Engine = {
    async make({ ttlSeconds, clientKey, ...params }) {
      const { give, giveAmount, get, getAmount } = legs(params);
      const order = await acct.swap.create({
        sourceNetwork: 'canton', sourceTokenAddress: give, sourceTokenName: give, sourceAmount: giveAmount,
        targetNetwork: 'canton', targetTokenAddress: get, targetTokenName: get, targetAmount: getAmount,
        dvp: true,
        description: intentTag(clientKey),
        ...(ttlSeconds && { expirationHours: Math.max(1, Math.ceil(ttlSeconds / 3600)) }),
      });
      return { orderId: order.id };
    },
    async findIntent(intent, known) {
      const [base = '', quote = ''] = intent.pair.split('/');
      const { give, giveAmount, get, getAmount } = legs({ base, quote, side: intent.side, amount: intent.amount, price: intent.price });
      // shortcut: one page of 100 in the API's default order (no created-at sort exists; ids are UUIDs), so an
      // intent's order outside it is dropped, not found; page through if bots ever hold that many orders.
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
    async cancel(orderId) {
      await acct.swap.cancel(orderId);
    },
    async order(orderId) {
      const o = await acct.swap.get(orderId);
      return { orderId: o.id, status: o.status, source: o.sourceTokenAddress, sourceAmount: o.sourceAmount, target: o.targetTokenAddress, targetAmount: o.targetAmount };
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
