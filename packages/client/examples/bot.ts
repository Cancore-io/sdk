// One bot account, from the key the wallet shows to a first trade. Run ONE process per bot.
//   CANCORE_BOT_KEY=… npx tsx bot.ts
import { providerFromSeed } from '@cancore/wallet';
import { createSelfCustody, type ConsentedDocument } from '@cancore/client/selfcustody';

const env = process.env;
// The key comes from your secret store through the environment. Never put it in the source, and never print it.
if (!env.CANCORE_BOT_KEY) throw new Error('set CANCORE_BOT_KEY: the 64 hex characters the wallet showed');
const signer = await providerFromSeed(env.CANCORE_BOT_KEY);
const bot = createSelfCustody({ baseUrl: env.CANCORE_API ?? 'https://api-dev.cancore.app', signer });
await bot.session.login(); // the wallet created the account, so there is no sign-up

const me = await bot.onboard(); // completes whatever setup is missing (party, CC receipts); signs nothing when none is
console.log('party', me.partyId); // the address the owner funds

console.log('CC', (await bot.balance('CC')).balance); // a decimal string; or 'CBTC', 'USDCx', …

// A token that arrived as an offer waits for this key's signature. One refusal does not stop the rest.
const { accepted, failed } = await bot.acceptIncoming();
for (const t of accepted) console.log('accepted', t.amount, t.instrumentId);
for (const f of failed) console.error('not accepted', f.transfer.contractId, f.error);

// Orders are refused until this account has accepted the documents the stand requires. Accept only what you read.
const terms = await bot.legalStatus();
if (!terms.accepted && terms.requiredVersion) {
  if (!env.CANCORE_LEGAL_DOCUMENTS) throw new Error(`the stand requires terms ${terms.requiredVersion}: set CANCORE_LEGAL_DOCUMENTS`);
  await bot.acceptTerms(terms.requiredVersion, JSON.parse(env.CANCORE_LEGAL_DOCUMENTS) as ConsentedDocument[]);
}

// Maker (CANCORE_PAIR_ID, SELL_AMOUNT, ASK_AMOUNT): place one order and settle it once somebody else takes it.
if (env.CANCORE_PAIR_ID && env.SELL_AMOUNT && env.ASK_AMOUNT) {
  // side 'sell': offer SELL_AMOUNT of the pair's base token, want ASK_AMOUNT of its quote token.
  const order = await bot.swap.createForPair({ tradingPairId: env.CANCORE_PAIR_ID, sourceAmount: env.SELL_AMOUNT, targetAmount: env.ASK_AMOUNT, side: 'sell' });
  console.log('placed', order.id);
  const { swap } = await bot.make(order.id, { autoWithdraw: true }); // waits for a taker, signs, funds its leg, waits for the settle
  console.log('settled', swap.id, swap.status);
}

// Taker (CANCORE_ORDER_ID, PAY_TOKEN, MAX_PAY): take one open order. The bot pays its target amount and gets its source amount.
if (env.CANCORE_ORDER_ID) {
  const order = await bot.swap.get(env.CANCORE_ORDER_ID);
  if (order.status !== 'open' || order.dvp !== true) throw new Error(`order ${order.id} is ${order.status}, dvp=${order.dvp}`);
  if (order.targetTokenName !== env.PAY_TOKEN || !(Number(order.targetAmount) <= Number(env.MAX_PAY))) {
    throw new Error(`order ${order.id} asks ${order.targetAmount} ${order.targetTokenName}: set PAY_TOKEN and MAX_PAY to agree to it`);
  }
  // autoSplitForFee: the platform fee needs a holding of its own (CC only). autoWithdraw: release our funds if the maker never funds.
  const { swap } = await bot.take(order.id, { autoSplitForFee: true, autoWithdraw: true });
  console.log('settled', swap.id, swap.status);
}

// Withdraw (CANCORE_OWNER_PARTY, WITHDRAW_AMOUNT, optional WITHDRAW_TOKEN): an ordinary send, signed by the bot.
if (env.CANCORE_OWNER_PARTY && env.WITHDRAW_AMOUNT) {
  await bot.send({ receiverPartyId: env.CANCORE_OWNER_PARTY, amount: env.WITHDRAW_AMOUNT, tokenId: env.WITHDRAW_TOKEN }); // no tokenId: CC
  console.log('sent', env.WITHDRAW_AMOUNT, env.WITHDRAW_TOKEN ?? 'CC');
}
