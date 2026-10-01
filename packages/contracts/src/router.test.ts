import {
  ATTESTOR_SET_ABI,
  ATTESTOR_SET_ERRORS,
  CANCORE_ROUTER_ABI,
  CANCORE_ROUTER_ERRORS,
  CNRX_ABI,
  CNRX_ERRORS,
  IBURN_MINT_ERC20_ABI,
  ICANCORE_ROUTER_ABI,
  ICANCORE_ROUTER_ERRORS,
  ORDER_TYPES,
  typeHash,
} from './index';

// What the taker client (`@cancore/trader/taker`, RouterReader) and the filler
// node read off the router. A rename or a dropped view in evm-contracts fails
// here on the next sync, not in a node that is already holding someone's order.

type Param = { readonly name: string; readonly type: string; readonly internalType?: string; readonly components?: readonly Param[] };
type Entry = { readonly type: string; readonly name?: string; readonly inputs?: readonly Param[] };

const entries = (abi: readonly Entry[], type: string) => abi.filter((e) => e.type === type).map((e) => e.name);

const ROUTER_READS = [
  'intents', 'filled', 'fillerActiveFrom', 'fillerRemovedAt', 'isFillerActive', 'wasFillerActiveAt', 'ticketSigners',
  'proofWindow', 'attestationSetFor', 'sourceOrderHash', 'hashTicket', 'minInput',
];
const ROUTER_WRITES = ['fill', 'settle', 'refund', 'openFor'];
const ROUTER_EVENTS = ['IntentOpened', 'Filled', 'Settled', 'Refunded'];
const ATTESTOR_SET_READS = ['getAttestorSet', 'currentSetId', 'isMember', 'revokedAttestors'];

test('the router ABIs and their error tables are exported from the package root', () => {
  for (const value of [CANCORE_ROUTER_ABI, ICANCORE_ROUTER_ABI, ATTESTOR_SET_ABI]) expect(value.length).toBeGreaterThan(0);
  for (const table of [CANCORE_ROUTER_ERRORS, ICANCORE_ROUTER_ERRORS, ATTESTOR_SET_ERRORS]) {
    expect(Object.keys(table).length).toBeGreaterThan(0);
  }
});

// CAN-1789: CNRX and IBurnMintERC20 left evm-contracts/abi/ for vendor/. A sync
// that only read abi/ would drop these three from the index without an error.
test('the vendored CNRX exports are still published', () => {
  expect(CNRX_ABI.length).toBeGreaterThan(0);
  expect(IBURN_MINT_ERC20_ABI.length).toBeGreaterThan(0);
  expect(Object.keys(CNRX_ERRORS).length).toBeGreaterThan(0);
});

test('CancoreRouter exposes every view RouterReader reads and every call the taker sends', () => {
  const functions = entries(CANCORE_ROUTER_ABI, 'function');
  expect(functions).toEqual(expect.arrayContaining([...ROUTER_READS, ...ROUTER_WRITES]));
});

test('CancoreRouter emits the events the taker follows', () => {
  expect(entries(CANCORE_ROUTER_ABI, 'event')).toEqual(expect.arrayContaining(ROUTER_EVENTS));
  expect(entries(ICANCORE_ROUTER_ABI, 'event')).toEqual(expect.arrayContaining(ROUTER_EVENTS));
});

test('AttestorSet exposes the set reads, and the router inherits them', () => {
  expect(entries(ATTESTOR_SET_ABI, 'function')).toEqual(expect.arrayContaining(ATTESTOR_SET_READS));
  expect(entries(CANCORE_ROUTER_ABI, 'function')).toEqual(expect.arrayContaining(ATTESTOR_SET_READS));
});

describe('Order', () => {
  // `createdAt` between `recipient` and `fillDeadline` since CAN-1683.
  const typedData = ORDER_TYPES.Order.map((f) => `${f.type} ${f.name}`);

  test.each(ROUTER_WRITES)('%s takes the 11-field Order tuple in the typed-data order', (name) => {
    for (const abi of [CANCORE_ROUTER_ABI, ICANCORE_ROUTER_ABI] as const) {
      const fn = (abi as readonly Entry[]).find((e) => e.type === 'function' && e.name === name);
      const order = fn?.inputs?.find((p) => p.internalType === 'struct ICancoreRouter.Order');
      expect(order?.components?.map((c) => `${c.type} ${c.name}`)).toEqual(typedData);
    }
  });

  test('ORDER_TYPEHASH from the package typed data is the router’s', () => {
    expect(typedData).toHaveLength(11);
    expect(typeHash(ORDER_TYPES, 'Order')).toBe('0x1f93a050ad6e8cc50e77b273767fdc0bfbb439bade69b3ffc73337227024750a');
  });
});
