// Shared by partner-maker.ts and partner-taker.ts: open the account, sign in, onboard, accept the terms.
import { providerFromMnemonic } from '@cancore/wallet';
import { isSdkError } from '@cancore/client';
import { createSelfCustody, type ConsentedDocument, type SelfCustodyAccount } from '@cancore/client/selfcustody';

const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`set ${name}`);
  return value;
};

export const baseUrl = process.env.CANCORE_API ?? 'https://api-dev.cancore.app';

export async function openAccount(): Promise<SelfCustodyAccount> {
  // The phrase comes from your secret store via the environment; it never leaves this process.
  const signer = await providerFromMnemonic(need('CANCORE_MNEMONIC'), {
    account: Number(process.env.CANCORE_ACCOUNT_INDEX ?? 0),
  });
  const acct = createSelfCustody({ baseUrl, signer });

  // Sign in; the first run signs up with the invite code instead.
  try {
    await acct.session.login();
  } catch (err) {
    if (!isSdkError(err, 'ACCOUNT_NOT_FOUND')) throw err;
    const inviteCode = need('CANCORE_INVITE_CODE');
    let user = await acct.session.register({ inviteCode });
    // An activation that did not finish: the same key and code may sign up again.
    if (user.status === 'FAILED') user = await acct.session.register({ inviteCode });
    if (user.status === 'FAILED') throw new Error('sign-up did not finish; run again later');
  }

  // The Canton party and CC receipts. Skips whatever already exists.
  const user = await acct.onboard();
  if (!user.roles.includes('partner-bot')) console.warn('this account has no partner-bot role: no cashback');

  // Orders are refused until the documents the stand requires are accepted. Only ever accept what you read.
  const { accepted, requiredVersion } = await acct.legalStatus();
  if (!accepted && requiredVersion) {
    const documents = JSON.parse(need('CANCORE_LEGAL_DOCUMENTS')) as ConsentedDocument[];
    await acct.acceptTerms(requiredVersion, documents);
  }

  console.log(`signed in as ${user.partyId}`);
  return acct;
}
