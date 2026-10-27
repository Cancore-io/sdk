// What My bots does in the wallet, from a program: list your bots, make one, stop or resume one.
//   CANCORE_PHRASE='…' BOT_NAME=grid-bot-1 npx tsx owner-bots.ts
import { providerFromMnemonic } from '@cancore/wallet';
import { createSelfCustody, nextBotAccount } from '@cancore/client/selfcustody';

const env = process.env;
// The phrase opens your wallet and every bot of it. It comes from your secret store; never print it.
if (!env.CANCORE_PHRASE) throw new Error('set CANCORE_PHRASE: the recovery phrase of your wallet');
const phrase = env.CANCORE_PHRASE;
const keyAt = (account: number) => providerFromMnemonic(phrase, { account }); // m/44'/6767'/{account}'/0'/0'
const owner = createSelfCustody({ baseUrl: env.CANCORE_API ?? 'https://api-dev.cancore.app', signer: await keyAt(0) });
await owner.session.login(); // your own sign-in: an app-session grant can neither make nor stop a bot

const bots = await owner.bots.list();
for (const b of bots) console.log(b.id, b.name, b.partyId ?? 'no party yet', b.stoppedAt ? 'stopped' : 'running');

if (env.BOT_NAME) {
  // The index the wallet would pick, so its Show key shows this bot's key.
  const account = await nextBotAccount(bots, async (n) => (await keyAt(n)).public_key);
  if (account === null) throw new Error('all five bot accounts are made');
  const bot = await owner.bots.create({ name: env.BOT_NAME, botSigner: await keyAt(account) });
  console.log('made', bot.id, bot.name, 'from account', account);
}

if (env.STOP_BOT_ID) console.log('stopped at', (await owner.bots.stop(env.STOP_BOT_ID)).stoppedAt);
if (env.RESUME_BOT_ID) console.log('running', (await owner.bots.resume(env.RESUME_BOT_ID)).name);
