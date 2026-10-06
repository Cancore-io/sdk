/**
 * The two ERC-20 views the filler reads before it binds itself to a delivery
 * (V-E5): its balance of the output asset and its allowance to the router.
 * The entries come from the ERC-20 ABI `@cancore/contracts` ships.
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
