import { CANCORE_ROUTER_ABI, IBURN_MINT_ERC20_ABI, type Hex } from '@cancore/contracts';
import { AbiCoder, Interface } from 'ethers';
import {
  AbiDecodeError,
  decodeEventLog,
  decodeFunctionResult,
  decodeParams,
  encodeEventLog,
  encodeFunctionCall,
  entryOf,
  selectorOf,
  signatureOf,
  type AbiEntry,
} from './abi';

// ethers is an independent implementation of the same ABI: every encoding
// here is held to it, both ways.
const ROUTER = CANCORE_ROUTER_ABI as unknown as readonly AbiEntry[];
const router = new Interface(CANCORE_ROUTER_ABI as never);
const erc20 = new Interface(IBURN_MINT_ERC20_ABI as never);

const ORDER = {
  user: '0x1111111111111111111111111111111111111111',
  originChainId: 56n,
  inputToken: '0x0000000000000000000000000000000000000056',
  inputAmount: 105n,
  destination: `0x${'00'.repeat(31)}01`,
  outputAsset: `0x${'00'.repeat(12)}${'0a'.repeat(20)}`,
  minReceived: 99n,
  recipient: `0x${'00'.repeat(12)}${'0b'.repeat(20)}`,
  createdAt: 1_790_000_000n,
  fillDeadline: 1_790_000_600n,
  feeBps: 500n,
};
const HASH: Hex = `0x${'ab'.repeat(32)}`;
const FILLER_ID: Hex = `0x${'f1'.repeat(32)}`;
const DELIVERY_KEY = '0x2222222222222222222222222222222222222222';
const REPAY_TO: Hex = `0x${'00'.repeat(12)}${'0c'.repeat(20)}`;

describe('selectors and calldata match ethers for every view the filler reads', () => {
  const calls: Array<[string, unknown[]]> = [
    ['intents', [HASH]],
    ['filled', [HASH]],
    ['ticketSigners', ['0x2222222222222222222222222222222222222222']],
    ['proofWindow', [`0x${'00'.repeat(31)}01`]],
    ['attestationSetFor', [HASH]],
    ['getAttestorSet', [7]],
    ['revokedAttestors', ['0x2222222222222222222222222222222222222222']],
    ['currentSetId', []],
    ['isMember', [7, '0x2222222222222222222222222222222222222222']],
    ['sourceOrderHash', [ORDER]],
    ['hashOrder', [ORDER]],
    ['hashTicket', [{ orderHash: HASH, fillerId: FILLER_ID, deliveryKey: DELIVERY_KEY, repayTo: REPAY_TO, attempt: 2, validFrom: 10n, validUntil: 20n }]],
    ['minInput', ['0x0000000000000000000000000000000000000056']],
  ];

  test.each(calls)('%s', (name, args) => {
    const entry = entryOf(ROUTER, 'function', name);
    expect(selectorOf(entry)).toBe(router.getFunction(name)!.selector);
    expect(encodeFunctionCall(entry, args)).toBe(router.encodeFunctionData(name, args.map((a) => (typeof a === 'object' && a !== null && !Array.isArray(a) ? Object.values(a) : a))));
  });

  test('a canonical signature expands tuples', () => {
    expect(signatureOf(entryOf(ROUTER, 'function', 'hashTicket'))).toBe('hashTicket((bytes32,bytes32,address,bytes32,uint32,uint64,uint64))');
  });
});

describe('results decode as ethers encodes them', () => {
  test('a struct with a dynamic array: getAttestorSet', () => {
    const members = ['0x00000000000000000000000000000000000000a1', '0x00000000000000000000000000000000000000b2'];
    const data = router.encodeFunctionResult('getAttestorSet', [members, 2, 100n, 0n]) as Hex;
    expect(decodeFunctionResult(entryOf(ROUTER, 'function', 'getAttestorSet'), data)).toEqual({ members, threshold: 2n, activeFrom: 100n, retiredAt: 0n });
  });

  test('a multi-output view: intents', () => {
    const data = router.encodeFunctionResult('intents', [1, 1_790_003_600n, 1_790_000_000n]) as Hex;
    expect(decodeFunctionResult(entryOf(ROUTER, 'function', 'intents'), data)).toEqual({ status: 1n, refundAfter: 1_790_003_600n, openedAt: 1_790_000_000n });
  });

  test('ERC-20 balanceOf', () => {
    const entry = (IBURN_MINT_ERC20_ABI as unknown as AbiEntry[]).find((e) => e.name === 'balanceOf')!;
    expect(decodeFunctionResult(entry, erc20.encodeFunctionResult('balanceOf', [12345n]) as Hex)).toBe(12345n);
  });

  test('strings, bytes and signed integers round-trip', () => {
    const params = [{ type: 'string' }, { type: 'bytes' }, { type: 'int64' }, { type: 'uint8[]' }];
    const values = ['héllo', '0x0102030405', -42n, [1n, 2n, 3n]];
    const data = AbiCoder.defaultAbiCoder().encode(['string', 'bytes', 'int64', 'uint8[]'], values) as Hex;
    expect(decodeParams(params, data)).toEqual(values);
  });
});

describe('router events encode and decode as ethers does', () => {
  test('IntentOpened carries the whole order', () => {
    const entry = entryOf(ROUTER, 'event', 'IntentOpened');
    const args = { orderHash: HASH, order: ORDER, refundAfter: 1_790_003_600n, blockNumber: 42n };
    const ours = encodeEventLog(entry, args);
    const theirs = router.encodeEventLog('IntentOpened', [HASH, Object.values(ORDER), 1_790_003_600n, 42n]);
    expect(ours).toEqual({ topics: theirs.topics, data: theirs.data });
    expect(decodeEventLog(entry, ours)).toEqual({ ...args, order: { ...ORDER, destination: ORDER.destination, outputAsset: ORDER.outputAsset } });
  });

  test('Filled: two indexed words in topics, the delivery key and repayTo in the data', () => {
    const entry = entryOf(ROUTER, 'event', 'Filled');
    const recipient = `0x${'00'.repeat(12)}${'0b'.repeat(20)}`;
    const theirs = router.encodeEventLog('Filled', [HASH, FILLER_ID, DELIVERY_KEY, REPAY_TO, 99n, recipient, 1_790_000_100n, 0]);
    expect(theirs.topics).toHaveLength(3);
    expect(decodeEventLog(entry, { topics: theirs.topics as Hex[], data: theirs.data as Hex })).toEqual({
      orderHash: HASH,
      fillerId: FILLER_ID,
      deliveryKey: DELIVERY_KEY,
      repayTo: REPAY_TO,
      received: 99n,
      recipient,
      filledAt: 1_790_000_100n,
      attempt: 0n,
    });
  });

  test('a log of another event is refused', () => {
    const settled = router.encodeEventLog('Settled', [HASH, FILLER_ID, REPAY_TO, 1n, 1n]);
    expect(() => decodeEventLog(entryOf(ROUTER, 'event', 'Filled'), { topics: settled.topics as Hex[], data: settled.data as Hex })).toThrow(AbiDecodeError);
  });
});

describe('a malformed or hostile answer is refused, never coerced', () => {
  const intents = entryOf(ROUTER, 'function', 'intents');
  const filled = entryOf(ROUTER, 'function', 'filled');
  const set = entryOf(ROUTER, 'function', 'getAttestorSet');
  const word = (n: bigint) => n.toString(16).padStart(64, '0');

  test.each([
    ['empty data (a call to an address without code)', intents, '0x'],
    ['a truncated struct', intents, `0x${word(1n)}${word(2n)}`],
    ['a bool word above 1', filled, `0x${word(2n)}`],
    ['a uint8 status above 255', intents, `0x${word(256n)}${word(1n)}${word(1n)}`],
    ['an array offset beyond the data', set, `0x${word(4096n)}${word(1n)}${word(1n)}${word(1n)}`],
    ['an array length beyond the data', set, `0x${word(128n)}${word(1n)}${word(1n)}${word(1n)}${word(10n ** 30n)}`],
    ['not hex', filled, '0xzz'],
  ])('%s', (_name, entry, data) => {
    expect(() => decodeFunctionResult(entry, data as Hex)).toThrow(AbiDecodeError);
  });

  test('an address word with high bits set', () => {
    const data = `0x${word(32n)}${word(1n)}${'ff'.repeat(12)}${'11'.repeat(20)}` as Hex;
    expect(() => decodeParams([{ type: 'address[]' }], data)).toThrow(AbiDecodeError);
  });
});
