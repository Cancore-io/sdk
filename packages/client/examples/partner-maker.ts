// A minimal Canton market maker: keep exactly one sell order on a pair, settle every trade with serve().
// Run ONE process per account: two processes with the same key would both quote and both sign.
//   CANCORE_MNEMONIC=… CANCORE_INVITE_CODE=… CANCORE_PAIR_ID=… npx tsx partner-maker.ts
import type { OrderStatus } from '@cancore/client';
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

// Our orders on this pair in the given states. listMine also returns orders we took, so keep only the ones we placed.
const ownOrders = async (statuses: OrderStatus[]) => {
  const pages = await Promise.all(statuses.map((statusFilter) => acct.swap.listMine({ statusFilter, pageSize: 100 })));
  return pages.flatMap((p) => p.items).filter((o) => o.initiatorUserId === me.id && o.tradingPairId === tradingPairId);
};
const openOrders = () => ownOrders(['open']);

// One order at a time, from placing to settling: a taken order still holds our funds until it settles,
// so a new one is placed only once none of ours is open or in flight. Extra open orders (left by a
// crash) are cancelled. An open order left by an earlier run keeps that run's price: after a crash
// with a changed ASK_AMOUNT, cancel it by hand and the next tick quotes the new one.
const reconcile = async () => {
  // Open first: an order taken between the two reads then shows up in the second.
  const open = await openOrders();
  const inFlight = await ownOrders(['accepted', 'swap_created', 'claimed']);
  for (const o of inFlight.length > 0 ? open : open.slice(1)) await acct.swap.cancel(o.id);
  if (inFlight.length > 0 || open.length > 0 || stopping) return;
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
  // No token (sign-in failed): connect without one, the gateway refuses it and the handler below retries.
  auth: (cb) => void acct.session.token().then((token) => cb({ token }), () => cb({})),
  transports: ['websocket'],
});
// A refused handshake is never retried by socket.io itself; try again in a minute, the poll covers the gap.
socket.on('connect_error', () => {
  if (!socket.active && !stopping) setTimeout(() => {
    if (!stopping) socket.connect();
  }, 60_000);
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

// No cashback here: a maker never funds the fee leg, so it earns none (guide, section 8).

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void (async () => {
    stopping = true;
    clearInterval(timer);
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
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
