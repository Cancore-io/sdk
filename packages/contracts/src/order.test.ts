import { TypedDataEncoder, id } from 'ethers';
import Ajv2020 from 'ajv/dist/2020';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CANTON_ORIGIN_ID, CANTON_SOURCE_ANCHOR } from './constants';
import { PERMIT2_ADDRESS } from './deployments';
import {
  buildCantonSourceOrder, hashOrder, hashPermitWitness, isCantonOriginId, permit2Domain, PERMIT_WITNESS_TYPES, sourceOrderHash,
  type CantonSourceIntent, type PermitWitness,
} from './order';
import { ORDER_TYPES, routerDomain, type Hex, type Order } from './protocol/typedData';
import { PROTOCOL_SCHEMAS, SCHEMA_VOCABULARY, messageSchemaRef } from './protocol/schemas';

// The router's order hashing, and the EVM-form Order of a Canton-source intent
// (protocol.md §3.7-3.9): a port of evm-contracts test/helpers/cantonOrder.ts,
// held to the vector the router test pins with sourceOrderHash and the Daml
// intent-test golden (canton-contracts intent-test/tools/canton-order.golden.json).

const spec = join(__dirname, '..', 'spec');
const load = <T>(...p: string[]): T => JSON.parse(readFileSync(join(spec, ...p), 'utf8')) as T;
type CantonVector = { input: Record<string, unknown>; order: Order; domain: { name: string; version: string; chainId: string; verifyingContract: Hex }; orderHash: Hex };
const canton = load<{ vector: CantonVector }>('vectors', 'canton-order.json').vector;
const input = canton.input as unknown as CantonSourceIntent;
const evmOrder = load<{ vectors: { note: string; domain: { chainId: string; verifyingContract: Hex }; order: Order; orderHash: Hex }[] }>('vectors', 'evm-order.json');
const permit = load<{ vectors: { note: string; chainId: string; verifyingContract: Hex; message: PermitWitness; witnessHash: Hex; digest: Hex }[] }>('vectors', 'permit-witness.json');
const orderTypes = JSON.parse(JSON.stringify(ORDER_TYPES)) as Record<string, { name: string; type: string }[]>;

describe('buildCantonSourceOrder', () => {
  test('reproduces canton-order.json: the order, the source domain and the orderHash the router pins', () => {
    const built = buildCantonSourceOrder(input);
    expect(built.order).toEqual(canton.order);
    expect(built.domain).toEqual(canton.domain);
    expect(built.orderHash).toBe(canton.orderHash);
    expect(built.orderHash).toBe('0x22e3a53ab72c6990b1971fd50b9ec6c527a003d987cd58d26058b380dd7ae79a');
    // keccak256(utf8("acme")): the filler the owner picked, the same word evm-contracts#108 and canton-contracts#216 pin
    expect(built.order.fillerId).toBe('0xe29dae06ef4c3e336b7538b6d4f52ca1ecec009b1df6fb501320e11b223aeeaf');
    expect(hashOrder(built.order, built.domain)).toBe(canton.orderHash);
    expect(sourceOrderHash(built.order)).toBe(canton.orderHash);
    expect(TypedDataEncoder.hash(built.domain, orderTypes, built.order)).toBe(canton.orderHash);
  });

  test('accepts the chain ids as bigint, string or number and the times as number or string', () => {
    const variant = { ...input, cantonOriginId: CANTON_ORIGIN_ID.mainnet, destinationChainId: 1, createdAt: '1789999400', fillDeadline: '1790000000' };
    expect(buildCantonSourceOrder(variant as never).orderHash).toBe(canton.orderHash);
  });

  test.each([
    ['createdAt + 1 (the owner-signed orderCreatedAt)', { createdAt: (input.createdAt as number) + 1 }],
    ['requestId', { requestId: `${input.requestId}x` }],
    ['ownerPartyId', { ownerPartyId: `${input.ownerPartyId}0` }],
    ['instrumentId', { instrumentId: 'USDC' }],
    ['amount', { amount: '1250.5000000001' }],
    ['minReceived', { minReceived: '1200.250001' }],
    ['fillDeadline', { fillDeadline: (input.fillDeadline as number) + 1 }],
    ['feeRate', { feeRate: '0.0031' }],
    ['the Canton network', { cantonOriginId: CANTON_ORIGIN_ID.devnet }],
    ['fillerId (another filler)', { fillerId: 'acme2' }],
  ])('a change of %s changes the orderHash', (_n, change) => {
    expect(buildCantonSourceOrder({ ...input, ...change } as never).orderHash).not.toBe(canton.orderHash);
  });

  test.each([
    ['fillDeadline with a fraction of a second', { fillDeadline: 1790000000.5 }],
    ['createdAt with a fraction of a second', { createdAt: 1789999400.25 }],
    ['minReceived finer than the token decimals', { minReceived: '1200.2500001' }],
    ['amount finer than Daml Numeric 10', { amount: '1250.50000000001' }],
    ['feeRate above MAX_FEE_BPS', { feeRate: '0.1001' }],
    ['feeRate finer than a basis point', { feeRate: '0.00305' }],
    ['a signed amount', { amount: '-1' }],
    ['an exponent', { amount: '1e3' }],
    ['an origin id inside the EVM chain-id range', { cantonOriginId: 1n }],
    ['an origin id above uint64', { cantonOriginId: 2n ** 64n }],
    ['a recipient that is not an address', { recipient: '0x1234' }],
    ['a wantToken that is not an address', { wantToken: 'usdc' }],
    ['an empty fillerId (no picked filler: nobody could fill it)', { fillerId: '' }],
    ['a missing fillerId', { fillerId: undefined }],
    ['a fillerId outside the issued alphabet', { fillerId: 'Acme' }],
  ])('%s is refused: the order is not built', (_n, change) => {
    expect(() => buildCantonSourceOrder({ ...input, ...change } as never)).toThrow();
  });
});

describe('hashOrder and sourceOrderHash', () => {
  test.each(evmOrder.vectors.map((v) => [v.note, v] as const))('evm-order.json %s: hashOrder in the source router domain', (_n, v) => {
    expect(hashOrder(v.order, v.domain)).toBe(v.orderHash);
    expect(hashOrder(v.order, routerDomain(v.domain.chainId, v.domain.verifyingContract))).toBe(v.orderHash);
    expect(TypedDataEncoder.hash({ name: 'CancoreRouter', version: '1', ...v.domain }, orderTypes, v.order)).toBe(v.orderHash);
  });

  test('evm-order.json is the EVM fixture order of spec/typed-data/Order.json', () => {
    const order = load<{ vectors: { message: Order; digest: Hex }[] }>('typed-data', 'Order.json').vectors[1]!;
    expect(evmOrder.vectors[0]!.order).toEqual(order.message);
    expect(evmOrder.vectors[0]!.orderHash).toBe(order.digest);
  });

  test('sourceOrderHash: a Canton origin hashes under the anchor; an EVM origin needs its registered source router', () => {
    const v = evmOrder.vectors[0]!;
    expect(sourceOrderHash(v.order, v.domain.verifyingContract)).toBe(v.orderHash);
    expect(() => sourceOrderHash(v.order)).toThrow(/source router/);
    expect(sourceOrderHash(canton.order, CANTON_SOURCE_ANCHOR)).toBe(canton.orderHash);
    expect(sourceOrderHash({ ...canton.order, originChainId: String(CANTON_ORIGIN_ID.devnet) })).toBe(
      hashOrder({ ...canton.order, originChainId: String(CANTON_ORIGIN_ID.devnet) }, { chainId: CANTON_ORIGIN_ID.devnet, verifyingContract: CANTON_SOURCE_ANCHOR }),
    );
  });

  test('the same order in another domain hashes differently', () => {
    const v = evmOrder.vectors[0]!;
    expect(hashOrder(v.order, { ...v.domain, chainId: '1' })).not.toBe(v.orderHash);
    expect(hashOrder(v.order, { ...v.domain, verifyingContract: CANTON_SOURCE_ANCHOR })).not.toBe(v.orderHash);
  });

  test('isCantonOriginId: the three Canton networks, nothing else', () => {
    for (const id of Object.values(CANTON_ORIGIN_ID)) expect(isCantonOriginId(id)).toBe(true);
    expect(isCantonOriginId(String(CANTON_ORIGIN_ID.testnet))).toBe(true);
    for (const id of [1n, 11155111n, 2n ** 63n, 2n ** 63n + 4n]) expect(isCantonOriginId(id)).toBe(false);
  });
});

describe('Permit2 witness: what the maker signs to open an EVM-source intent', () => {
  test.each(permit.vectors.map((v) => [v.note, v] as const))('permit-witness.json %s: the shipped digest, ethers and the witness hash agree', (_n, v) => {
    expect(hashPermitWitness(v.message, v.chainId, v.verifyingContract)).toBe(v.digest);
    const types = JSON.parse(JSON.stringify(PERMIT_WITNESS_TYPES)) as Record<string, { name: string; type: string }[]>;
    expect(TypedDataEncoder.hash(permit2Domain(v.chainId, v.verifyingContract), types, v.message)).toBe(v.digest);
    expect(TypedDataEncoder.hashStruct('Order', orderTypes, v.message.witness)).toBe(v.witnessHash);
  });

  test('defaults to the canonical Permit2 address; every field of the witness is signed', () => {
    const v = permit.vectors[0]!;
    expect(v.verifyingContract).toBe(PERMIT2_ADDRESS);
    expect(hashPermitWitness(v.message, v.chainId)).toBe(v.digest);
    expect(permit2Domain(v.chainId)).toEqual({ name: 'Permit2', chainId: v.chainId, verifyingContract: PERMIT2_ADDRESS });
    expect(hashPermitWitness({ ...v.message, witness: { ...v.message.witness, feeBps: '31' } }, v.chainId)).not.toBe(v.digest);
    expect(hashPermitWitness({ ...v.message, witness: { ...v.message.witness, fillerId: `0x${'00'.repeat(32)}` } }, v.chainId)).not.toBe(v.digest);
    expect(hashPermitWitness({ ...v.message, permitted: { ...v.message.permitted, amount: '1' } }, v.chainId)).not.toBe(v.digest);
    expect(hashPermitWitness({ ...v.message, spender: CANTON_SOURCE_ANCHOR }, v.chainId)).not.toBe(v.digest);
  });
});

describe('twelve-field public acceptance', () => {
  const canton = JSON.parse(readFileSync(join(__dirname, '../spec/vectors/canton-order.json'), 'utf8')).vector;
  const types = { Order: [
    { name: 'user', type: 'address' }, { name: 'originChainId', type: 'uint64' },
    { name: 'inputToken', type: 'address' }, { name: 'inputAmount', type: 'uint256' },
    { name: 'destination', type: 'bytes32' }, { name: 'outputAsset', type: 'bytes32' },
    { name: 'minReceived', type: 'uint256' }, { name: 'recipient', type: 'bytes32' },
    { name: 'createdAt', type: 'uint64' }, { name: 'fillDeadline', type: 'uint64' },
    { name: 'feeBps', type: 'uint16' }, { name: 'fillerId', type: 'bytes32' },
  ] };
  const order: Order & { fillerId: `0x${string}` } = { ...canton.order, fillerId: id('acme') as `0x${string}` };
  const input = { ...canton.input, fillerId: 'acme' };

  test('twelve-field public Order matches the independent Canton assertion', () => {
    expect(ORDER_TYPES.Order).toEqual(types.Order);
    expect(id(TypedDataEncoder.from(types).encodeType('Order'))).toBe('0xf68105debdb242de0650ab79cad1d11e4ed4f4e986e191ff672a79737f4c9d22');
    expect(hashOrder(order, canton.domain)).toBe('0x22e3a53ab72c6990b1971fd50b9ec6c527a003d987cd58d26058b380dd7ae79a');
    expect(buildCantonSourceOrder(input).order).toEqual(order);
    expect(sourceOrderHash(order)).toBe(TypedDataEncoder.hash(canton.domain, types, order));
  });

  test('changing only filler changes Order and nested Permit2 commitments', () => {
    const changed = { ...order, fillerId: id('bravo') as `0x${string}` };
    expect(hashOrder(order, canton.domain)).not.toBe(hashOrder(changed, canton.domain));
    expect(sourceOrderHash(changed)).toBe(TypedDataEncoder.hash(canton.domain, types, changed));
    const rebuilt = buildCantonSourceOrder({ ...input, fillerId: 'bravo' });
    expect(rebuilt.domain).toEqual(canton.domain);
    expect(rebuilt.orderHash).toBe(sourceOrderHash(changed));
    const witnessTypes = {
      PermitWitnessTransferFrom: [
        { name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' },
        { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'witness', type: 'Order' },
      ], TokenPermissions: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }], ...types,
    };
    const permit = { permitted: { token: order.inputToken, amount: order.inputAmount }, spender: canton.domain.verifyingContract, nonce: '1', deadline: '1790000000', witness: order };
    expect(hashPermitWitness(permit, '1')).toBe(TypedDataEncoder.hash(permit2Domain('1'), witnessTypes, permit));
    const mutated = { ...permit, witness: changed };
    expect(hashPermitWitness(permit, '1')).not.toBe(hashPermitWitness(mutated, '1'));
    expect(hashPermitWitness(mutated, '1')).toBe(TypedDataEncoder.hash(permit2Domain('1'), witnessTypes, mutated));
  });

  test.each([undefined, '', 'a'.repeat(64), 'Acme', ' acme', 'acme '])('Canton builder refuses operational filler %p', (fillerId) => {
    expect(() => buildCantonSourceOrder({ ...input, fillerId })).toThrow(/fillerId/);
  });

  test.each(['a', 'a'.repeat(63)])('Canton identity bound %p is preserved without normalization', (fillerId) => {
    const built = buildCantonSourceOrder({ ...input, fillerId });
    expect(built.order).toHaveProperty('fillerId', id(fillerId));
    expect(built.domain).toEqual(canton.domain);
    expect(built.orderHash).toBe(TypedDataEncoder.hash(canton.domain, types, built.order));
  });

  test.each(['acme', '0x1234', undefined])('raw filler word %p cannot enter either hash', (fillerId) => {
    const malformed = { ...order, fillerId } as unknown as Order;
    expect(() => hashOrder(malformed, canton.domain)).toThrow();
    expect(() => hashPermitWitness({ permitted: { token: order.inputToken, amount: '1' }, spender: canton.domain.verifyingContract, nonce: '1', deadline: '1', witness: malformed }, '1')).toThrow();
  });

  test.each(['ticket.offer', 'quote.reconfirm'])('%s schema refuses eleven-field and malformed-word Orders', (type) => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    ajv.addVocabulary([...SCHEMA_VOCABULARY]);
    for (const schema of Object.values(PROTOCOL_SCHEMAS)) ajv.addSchema(schema as object);
    const { examples } = JSON.parse(readFileSync(join(__dirname, '../spec/protocol/vectors/messages.json'), 'utf8'));
    const validOrder = { ...examples[type][0].order, fillerId: order.fillerId };
    const frame = { ...examples[type][0], order: validOrder };
    expect(ajv.validate(messageSchemaRef(type), frame)).toBe(true);
    for (const fillerId of [undefined, 'acme', '0x1234']) {
      expect(ajv.validate(messageSchemaRef(type), { ...frame, order: { ...validOrder, fillerId } })).toBe(false);
      expect(ajv.errors?.some((error) => error.instancePath === '/order/fillerId' || error.params.missingProperty === 'fillerId')).toBe(true);
    }
  });
});
