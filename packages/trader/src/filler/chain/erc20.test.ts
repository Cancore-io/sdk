import { IBURN_MINT_ERC20_ABI, type Hex } from '@cancore/contracts';
import { encodeFunctionCall, entryOf, type AbiEntry } from './abi';
import { ChainReadError, type ChainClient, type ReadAt } from './client';
import { BLOCKLIST_VIEWS, erc20Allowance, erc20BalanceOf, erc20Blocklisted } from './erc20';

const TOKEN = '0x1111111111111111111111111111111111111111' as Hex;
const OWNER = '0x2222222222222222222222222222222222222222' as Hex;
const SPENDER = '0x3333333333333333333333333333333333333333' as Hex;
const CHAIN = 'eip155:1';

const uintWord = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const selector = (data: Hex) => data.slice(0, 10);
const ERC20 = IBURN_MINT_ERC20_ABI as unknown as readonly AbiEntry[];
const BALANCE_OF = encodeFunctionCall(entryOf(ERC20, 'function', 'balanceOf'), [OWNER]);
const ALLOWANCE = encodeFunctionCall(entryOf(ERC20, 'function', 'allowance'), [OWNER, SPENDER]);
const [USDC_VIEW, USDT_VIEW] = BLOCKLIST_VIEWS.map((entry) => selector(encodeFunctionCall(entry, [OWNER])));

type Answer = Hex | ChainReadError | Error;

/** A token whose `eth_call` answers by selector; every call is recorded. */
function tokenAnswering(answers: Record<string, Answer>) {
  const calls: { to: Hex; data: Hex; at: ReadAt }[] = [];
  const client = {
    chain: CHAIN,
    async call(to: Hex, data: Hex, at: ReadAt) {
      calls.push({ to, data, at });
      const answer = answers[selector(data)];
      if (answer === undefined) throw new ChainReadError(CHAIN, 'reverted', 'no such function');
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as unknown as ChainClient;
  return { client, calls };
}

describe('erc20BalanceOf and erc20Allowance', () => {
  test('decode the uint256 the token returns, read at the depth asked for', async () => {
    const { client, calls } = tokenAnswering({ [selector(BALANCE_OF)]: uintWord(10n ** 24n), [selector(ALLOWANCE)]: uintWord(2n ** 256n - 1n) });
    await expect(erc20BalanceOf(client, TOKEN, OWNER, 'safe')).resolves.toBe(10n ** 24n);
    await expect(erc20Allowance(client, TOKEN, OWNER, SPENDER)).resolves.toBe(2n ** 256n - 1n);
    expect(calls.map((c) => [c.to, c.data, c.at])).toEqual([[TOKEN, BALANCE_OF, 'safe'], [TOKEN, ALLOWANCE, 'latest']]);
  });

  test('an answer that is not a uint256 word is a malformed read, not a balance', async () => {
    const { client } = tokenAnswering({ [selector(BALANCE_OF)]: '0x1234' });
    const read = erc20BalanceOf(client, TOKEN, OWNER);
    await expect(read).rejects.toBeInstanceOf(ChainReadError);
    await expect(read).rejects.toMatchObject({ reason: 'malformed', chain: CHAIN });
  });

  test('a revert is passed on as the read error it is', async () => {
    const { client } = tokenAnswering({});
    await expect(erc20BalanceOf(client, TOKEN, OWNER)).rejects.toMatchObject({ reason: 'reverted' });
  });
});

describe('erc20Blocklisted: USDC isBlacklisted, USDT isBlackListed (V-E4)', () => {
  const TRUE = uintWord(1n);
  const FALSE = uintWord(0n);

  test('the two views have different selectors', () => {
    expect(USDC_VIEW).not.toBe(USDT_VIEW);
  });

  test.each([
    ['USDC blocklists the account', { [USDC_VIEW!]: TRUE }, true],
    ['USDT blocklists the account', { [USDT_VIEW!]: TRUE }, true],
    ['USDC says no, USDT has no view', { [USDC_VIEW!]: FALSE }, false],
    ['neither view says yes', { [USDC_VIEW!]: FALSE, [USDT_VIEW!]: FALSE }, false],
    ['no view at all: every call reverts', {}, false],
    ['a fallback that returns nothing', { [USDC_VIEW!]: '0x' as Hex, [USDT_VIEW!]: '0x' as Hex }, false],
  ])('%s', async (_name, answers, expected) => {
    await expect(erc20Blocklisted(tokenAnswering(answers).client, TOKEN, OWNER)).resolves.toBe(expected);
  });

  test('a yes from the first view is the answer: the second is not asked', async () => {
    const { client, calls } = tokenAnswering({ [USDC_VIEW!]: TRUE, [USDT_VIEW!]: FALSE });
    await expect(erc20Blocklisted(client, TOKEN, OWNER, 'finalized')).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.at).toBe('finalized');
  });

  test('a read that fails otherwise than by a revert is thrown: the payout cannot be verified', async () => {
    const down = new ChainReadError(CHAIN, 'unavailable', 'no endpoint answered');
    await expect(erc20Blocklisted(tokenAnswering({ [USDC_VIEW!]: down }).client, TOKEN, OWNER)).rejects.toBe(down);
    const transport = new Error('socket hang up');
    await expect(erc20Blocklisted(tokenAnswering({ [USDT_VIEW!]: transport }).client, TOKEN, OWNER)).rejects.toBe(transport);
  });

  test('an answer that is not a bool word is a malformed read', async () => {
    await expect(erc20Blocklisted(tokenAnswering({ [USDC_VIEW!]: '0x01' as Hex }).client, TOKEN, OWNER)).rejects.toMatchObject({ reason: 'malformed' });
  });
});
