// A minimal Canton market maker: keep exactly one sell order on a pair, settle every trade with serve().
// Run ONE process per account: two processes with the same key would both quote and both sign.
//   CANCORE_MNEMONIC=… CANCORE_INVITE_CODE=… CANCORE_PAIR_ID=… npx tsx partner-maker.ts
import { io } from 'socket.io-client';
import { baseUrl, openAccount } from './partner-account';

const acct = await openAccount();
const me = await acct.me();
const tradingPairId = process.env.CANCORE_PAIR_ID;
if (!tradingPairId) throw new Error('set CANCORE_PAIR_ID (a pair whose base and quote are both on canton)');
const sell = process.env.SELL_AMOUNT ?? '10'; // base token offered per order
const ask = process.env.ASK_AMOUNT ?? '2'; // quote token wanted for it

console.log('CC balance', (await acct.balance('CC')).balance);

let stopping = false;

// Our open orders on this pair. listMine also returns orders we took, so keep only the ones we placed.
const openOrders = async () => {
  const { items } = await acct.swap.listMine({ statusFilter: 'open', pageSize: 100 });
  return items.filter((o) => o.initiatorUserId === me.id && o.tradingPairId === tradingPairId);
};

// Converge on exactly one open order: keep the first, cancel extras (left by a crash), place one if none.
const reconcile = async () => {
  const [keep, ...extra] = await openOrders();
  for (const o of extra) await acct.swap.cancel(o.id);
  if (keep || stopping) return;
  // Canton↔Canton: the SDK sends dvp: true, so the order settles through allocation-DvP.
  const order = await acct.swap.createForPair({ tradingPairId, sourceAmount: sell, targetAmount: ask, side: 'sell' });
  console.log('placed', order.id);
};

// One reconcile at a time, so a settle and the timer never place two orders.
let quoting: Promise<void> = Promise.resolve();
const requote = () => {
  quoting = quoting
    .then(() => (stopping ? undefined : reconcile()))
    .catch((err: unknown) => console.error('quoting failed, next tick retries', err));
  return quoting;
};

// Realtime makes the loop react at once; without the socket the 30 s poll alone drives it.
const socket = io(`${baseUrl}/presence`, {
  auth: (cb) => void acct.session.token().then((token) => cb({ token })),
  transports: ['websocket'],
});

const loop = acct.serve({
  socket,
  acceptIncoming: true, // registry-token deliveries and cashback payouts
  onEvent: (e) => {
    if (e.type === 'settled') console.log('settled', e.orderId, e.swapId);
    else if (e.type === 'expired') console.warn('expired', e.swapId, e.error.message);
    else if (e.type === 'withdrawn') console.log('released', e.swapId, e.withdrawal.withdrawn);
    else if (e.type === 'error') console.error('error', e.orderId ?? '', e.error);
    if (e.type === 'settled' || e.type === 'expired') void requote();
  },
});

await requote();
// Also once a minute: an order that expired by itself (expirationHours) sends no event.
const timer = setInterval(() => void requote(), 60_000);

// Cashback: claim whatever accrued, once an hour.
const cashback = setInterval(() => {
  void (async () => {
    const summary = await acct.cashback.summary();
    if (summary.claimable.length > 0 && !summary.hasPendingClaim) {
      const { claim, pending } = await acct.cashback.collect();
      console.log('cashback claim', claim.id, claim.status, 'payouts pending', pending);
    }
  })().catch((err: unknown) => console.error('cashback', err));
}, 60 * 60_000);

process.on('SIGTERM', () => {
  void (async () => {
    stopping = true;
    clearInterval(timer);
    clearInterval(cashback);
    try {
      // Stop signing first and let the step in flight finish; taken orders resume on the next start.
      await loop.stop();
      await quoting;
      // Then pull the open offer, so nobody takes an order no process is serving.
      const cancels = await Promise.allSettled((await openOrders()).map((o) => acct.swap.cancel(o.id)));
      if (cancels.some((c) => c.status === 'rejected')) throw new Error('an open order could not be cancelled; cancel it by hand');
    } catch (err) {
      console.error('shutdown', err);
      process.exitCode = 1;
    } finally {
      socket.close();
      process.exit();
    }
  })();
});
