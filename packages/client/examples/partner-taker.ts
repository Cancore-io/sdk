// A minimal taker: take one named Canton↔Canton order and settle the taker side.
//   CANCORE_MNEMONIC=… CANCORE_ORDER_ID=… MAX_PAY=… npx tsx partner-taker.ts
// MAX_PAY is the most of the order's target token you agree to pay. On mainnet also set CANCORE_ALLOW_MAINNET=yes.
import { API_NETWORKS, SettleError } from '@cancore/client/selfcustody';
import { baseUrl, openAccount } from './partner-account';

const orderId = process.env.CANCORE_ORDER_ID;
const maxPay = process.env.MAX_PAY;
if (!orderId || !maxPay) throw new Error('set CANCORE_ORDER_ID (the order to take) and MAX_PAY (the most you pay for it)');
const network = API_NETWORKS[new URL(baseUrl).hostname];
if (network !== 'devnet' && network !== 'testnet' && process.env.CANCORE_ALLOW_MAINNET !== 'yes') {
  // Mainnet, or a host the SDK cannot place: real funds may move, so refuse unless the operator opted in.
  throw new Error(`${baseUrl} may be mainnet; set CANCORE_ALLOW_MAINNET=yes to take orders there`);
}

const acct = await openAccount();
const order = await acct.swap.get(orderId);
if (order.status !== 'open' || order.dvp !== true) throw new Error(`order ${order.id} is ${order.status}, dvp=${order.dvp}`);
if (!(Number(order.targetAmount) <= Number(maxPay))) { // a MAX_PAY that is not a number refuses too
  throw new Error(`order ${order.id} asks ${order.targetAmount} ${order.targetTokenName}, above MAX_PAY ${maxPay}`);
}
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
