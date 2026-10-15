import { createSelfCustody, type DvpNetwork, type ServeHandle, type SessionOptions } from '@cancore/client/selfcustody';
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
export function createEngine(options: EngineOptions): Engine {
  const { hooks } = options;
  const guarded = guardSigning(options.signer, options.fetchImpl ?? ((url, init) => globalThis.fetch(url, init)), hooks.onVerifyFailed);
  const acct = createSelfCustody({
    baseUrl: options.baseUrl,
    signer: guarded.signer,
    fetchImpl: guarded.fetchImpl,
    ...(options.venuePartyId && { venuePartyId: options.venuePartyId }),
    ...(options.maxFeeRate && { maxFeeRate: options.maxFeeRate }),
    ...(options.feeRecipientPartyId && { feeRecipientPartyId: options.feeRecipientPartyId }),
    ...(options.network && { network: options.network }),
    ...(options.maxFee && { maxFee: options.maxFee }),
    ...(options.pollMs && { pollMs: options.pollMs }),
  });
  let loop: ServeHandle | undefined;

  const engine: Engine = {
    async make({ base, quote, side, amount, price, ttlSeconds }) {
      const [a, p] = [dec(amount), dec(price)];
      // The maker gives base for quote when selling, quote for base when buying; the bot never pays more than amount × price.
      const [give, giveAmount, get, getAmount] = side === 'sell'
        ? [base, amount, quote, fmt(mul(a, p, 'down'))]
        : [quote, fmt(mul(a, p, 'up')), base, amount];
      const order = await acct.swap.create({
        sourceNetwork: 'canton', sourceTokenAddress: give, sourceTokenName: give, sourceAmount: giveAmount,
        targetNetwork: 'canton', targetTokenAddress: get, targetTokenName: get, targetAmount: getAmount,
        dvp: true,
        ...(ttlSeconds && { expirationHours: Math.max(1, Math.ceil(ttlSeconds / 3600)) }),
      });
      return { orderId: order.id };
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
      return Promise.all(instruments.map(async (instrument) => ({ instrument, amount: (await acct.balance(instrument)).balance, locked: '0' })));
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
