// A minimal taker: take one open Canton↔Canton order and settle the taker side.
//   CANCORE_MNEMONIC=… CANCORE_ORDER_ID=… npx tsx partner-taker.ts   (no order id: the first open DvP order not ours)
import { SettleError } from '@cancore/client/selfcustody';
import { openAccount } from './partner-account';

const acct = await openAccount();
const me = await acct.me();

let orderId = process.env.CANCORE_ORDER_ID;
if (!orderId) {
  const { items } = await acct.swap.listOpen({ sourceNetwork: 'canton', targetNetwork: 'canton' });
  orderId = items.find((o) => o.dvp === true && o.initiatorUserId !== me.id)?.id;
  if (!orderId) throw new Error('no open Canton↔Canton DvP order to take');
}

const order = await acct.swap.get(orderId);
console.log(`taking ${order.id}: pay ${order.targetAmount} ${order.targetTokenName}, get ${order.sourceAmount} ${order.sourceTokenName}`);

try {
  const { swap } = await acct.take(order.id, {
    autoSplitForFee: true, // CC only: split a fee holding off when the venue asks for one
    autoWithdraw: true, // release our allocation if the maker never funds
  });
  console.log('settled', swap.id, swap.status);
} catch (err) {
  if (!(err instanceof SettleError)) throw err;
  console.error(err.message);
  if (err.withdrawable && err.swapId) console.error(`still locked: await acct.withdrawAllocation('${err.swapId}')`);
  process.exitCode = 1;
}
