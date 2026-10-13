// Verify the installed tarball, not the workspace source.
import { deepStrictEqual, notStrictEqual, strictEqual } from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TypedDataEncoder, id } from 'ethers';
import Ajv2020 from 'ajv/dist/2020.js';

const require = createRequire(resolve(process.argv[2] ?? process.cwd(), 'package.json'));
const load = (subpath) => import(pathToFileURL(require.resolve(`@cancore/contracts${subpath}`)).href, subpath.endsWith('.json') ? { with: { type: 'json' } } : {});
const sdk = await load('');
const { default: spec } = await load('/spec/typed-data/Order.json');
const { default: canton } = await load('/spec/vectors/canton-order.json');
const fields = [
  ['user', 'address'], ['originChainId', 'uint64'], ['inputToken', 'address'], ['inputAmount', 'uint256'],
  ['destination', 'bytes32'], ['outputAsset', 'bytes32'], ['minReceived', 'uint256'], ['recipient', 'bytes32'],
  ['createdAt', 'uint64'], ['fillDeadline', 'uint64'], ['feeBps', 'uint16'], ['fillerId', 'bytes32'],
];
const Order = fields.map(([name, type]) => ({ name, type }));
deepStrictEqual(sdk.ORDER_TYPES.Order, Order);
deepStrictEqual(spec.types.Order, Order);
strictEqual(id(TypedDataEncoder.from({ Order }).encodeType('Order')), '0xf68105debdb242de0650ab79cad1d11e4ed4f4e986e191ff672a79737f4c9d22');
for (const subpath of ['', '/abi']) {
  const abi = await load(subpath);
  for (const name of ['CANCORE_ROUTER_ABI', 'ICANCORE_ROUTER_ABI']) {
    const hash = abi[name].find((entry) => entry.type === 'function' && entry.name === 'hashOrder');
    deepStrictEqual(hash.inputs[0].components.map(({ name, type }) => [name, type]), fields);
  }
}
const built = sdk.buildCantonSourceOrder({ ...canton.vector.input, fillerId: 'acme' });
strictEqual(built.orderHash, '0x22e3a53ab72c6990b1971fd50b9ec6c527a003d987cd58d26058b380dd7ae79a');
const witness = {
  permitted: { token: built.order.inputToken, amount: built.order.inputAmount }, spender: built.domain.verifyingContract,
  nonce: '1', deadline: '1790000000', witness: built.order,
};
const types = {
  PermitWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'witness', type: 'Order' },
  ], TokenPermissions: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }], Order,
};
strictEqual(sdk.hashPermitWitness(witness, '1'), TypedDataEncoder.hash(sdk.permit2Domain('1'), types, witness));
notStrictEqual(sdk.hashPermitWitness(witness, '1'), sdk.hashPermitWitness({ ...witness, witness: { ...built.order, fillerId: id('bravo') } }, '1'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addVocabulary([...sdk.SCHEMA_VOCABULARY]);
for (const name of ['messages', 'rest', 'records']) {
  const { default: schema } = await load('/spec/protocol/' + name + '.schema.json');
  ajv.addSchema(schema);
}
const { default: messages } = await load('/spec/protocol/vectors/messages.json');
for (const type of ['ticket.offer', 'quote.reconfirm']) {
  const frame = messages.examples[type][0];
  strictEqual(ajv.validate(sdk.messageSchemaRef(type), frame), true);
  for (const fillerId of [undefined, 'acme', '0x1234']) {
    strictEqual(ajv.validate(sdk.messageSchemaRef(type), { ...frame, order: { ...frame.order, fillerId } }), false);
  }
}
console.log('packed contracts: twelve-field Order, ABI, Canton digest, Permit2 witness and schemas agree');
