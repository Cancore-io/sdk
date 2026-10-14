/**
 * The ERC-20 views the filler reads before it binds itself to a delivery: its
 * balance of the output asset and its allowance to the router (V-E5), and the
 * input token's blocklist for its payout address (V-E4). The balance and
 * allowance entries come from the ERC-20 ABI `@cancore/contracts` ships.
 */
import { IBURN_MINT_ERC20_ABI, type Hex } from '@cancore/contracts';
import { AbiDecodeError, decodeFunctionResult, encodeFunctionCall, entryOf, type AbiEntry } from './abi';
import { ChainReadError, type ChainClient, type ReadAt } from './client';

const ERC20_ABI = IBURN_MINT_ERC20_ABI as unknown as readonly AbiEntry[];
const BALANCE_OF = entryOf(ERC20_ABI, 'function', 'balanceOf');
const ALLOWANCE = entryOf(ERC20_ABI, 'function', 'allowance');

async function read(client: ChainClient, token: Hex, entry: AbiEntry, args: readonly unknown[], at: ReadAt): Promise<bigint> {
  const data = await client.call(token, encodeFunctionCall(entry, args), at);
  try {
    return decodeFunctionResult(entry, data) as bigint;
  } catch (error) {
    if (error instanceof AbiDecodeError) throw new ChainReadError(client.chain, 'malformed', `${entry.name} of ${token}: ${error.message}`, { cause: error });
    throw error;
  }
}

export const erc20BalanceOf = (client: ChainClient, token: Hex, owner: Hex, at: ReadAt = 'latest'): Promise<bigint> => read(client, token, BALANCE_OF, [owner], at);

export const erc20Allowance = (client: ChainClient, token: Hex, owner: Hex, spender: Hex, at: ReadAt = 'latest'): Promise<bigint> =>
  read(client, token, ALLOWANCE, [owner, spender], at);

/**
 * The blocklist views of the stablecoins a source may take in: USDC
 * `isBlacklisted(address)`, USDT `isBlackListed(address)`. Not ERC-20; a token
 * without one reverts (or returns nothing) and simply has no blocklist.
 */
export const BLOCKLIST_VIEWS: readonly AbiEntry[] = ['isBlacklisted', 'isBlackListed'].map((name) => ({
  type: 'function',
  name,
  stateMutability: 'view',
  inputs: [{ name: 'account', type: 'address' }],
  outputs: [{ name: '', type: 'bool' }],
})) as unknown as readonly AbiEntry[];

/**
 * Whether `token` blocklists `account`: true when any blocklist view it has
 * says so, false when none does or it has none. A read that fails otherwise
 * than by a revert is thrown (the caller treats it as unverifiable).
 */
export async function erc20Blocklisted(client: ChainClient, token: Hex, account: Hex, at: ReadAt = 'latest'): Promise<boolean> {
  for (const entry of BLOCKLIST_VIEWS) {
    let data: Hex;
    try {
      data = await client.call(token, encodeFunctionCall(entry, [account]), at);
    } catch (error) {
      if (error instanceof ChainReadError && error.reason === 'reverted') continue; // no such view
      throw error;
    }
    if (data === '0x') continue; // a fallback that returns nothing: no such view
    try {
      if (decodeFunctionResult(entry, data) === true) return true;
    } catch (error) {
      if (error instanceof AbiDecodeError) throw new ChainReadError(client.chain, 'malformed', `${entry.name} of ${token}: ${error.message}`, { cause: error });
      throw error;
    }
  }
  return false;
}
