// A minimal Canton market maker: keep one sell order on a pair, settle every trade with serve().
//   CANCORE_MNEMONIC=… CANCORE_INVITE_CODE=… CANCORE_PAIR_ID=… npx tsx partner-maker.ts
import { io } from 'socket.io-client';
import { baseUrl, openAccount } from './partner-account';

const acct = await openAccount();
const tradingPairId = process.env.CANCORE_PAIR_ID;
if (!tradingPairId) throw new Error('set CANCORE_PAIR_ID (GET /trading-pairs?network=canton lists them)');
const sell = process.env.SELL_AMOUNT ?? '10'; // base token offered per order
const ask = process.env.ASK_AMOUNT ?? '2'; // quote token wanted for it

console.log('CC balance', (await acct.balance('CC')).balance);

const place = async () => {
  // Canton↔Canton: the SDK sends dvp: true, so the order settles through allocation-DvP.
  const order = await acct.swap.createForPair({ tradingPairId, sourceAmount: sell, targetAmount: ask, side: 'sell' });
  console.log('placed', order.id);
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
    if (e.type === 'settled') {
      console.log('settled', e.orderId, e.swapId);
      void place().catch((err: unknown) => console.error('re-placing failed', err));
    } else if (e.type === 'expired') console.warn('expired', e.swapId, e.error.message);
    else if (e.type === 'withdrawn') console.log('released', e.swapId, e.withdrawal.withdrawn);
    else if (e.type === 'error') console.error('error', e.orderId ?? '', e.error);
  },
});

await place();

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
    clearInterval(cashback);
    // Pull open offers first, then let the step in flight finish. Taken orders resume on the next start.
    const { items } = await acct.swap.listMine({ statusFilter: 'open', pageSize: 100 });
    await Promise.allSettled(items.map((o) => acct.swap.cancel(o.id)));
    await loop.stop();
    socket.close();
    process.exit(0);
  })();
});
