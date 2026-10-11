import { getAddress, keccak256, toUtf8Bytes, TypedDataEncoder } from 'ethers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pkg from './index';
import {
  BPS, CANTON_ORIGIN_ID, CANTON_SOURCE_ANCHOR, DAML_NUMERIC_SCALE, EIP2294_MAX_CHAIN_ID, GRACE, INSTRUMENT_LABEL_TAG, MAX_FEE_BPS, MAX_FILL_TTL,
  MAX_PROOF_WINDOW, MAX_SIG_TTL, MIN_FILL_TTL, OWNER_LABEL_TAG, SET_DELAY,
} from './constants';
import { PROOF_KIND_ATTESTATION } from './eip712';
import { CONTRACTS_RELEASE } from './generated/meta';
import { FILL_PROOF_TYPES } from './eip712';
import { typeHash } from './protocol/hash';
import { FILL_TICKET_TYPES, ORDER_TYPES, QUOTE_TYPES } from './protocol/typedData';
import { PERMIT_WITNESS_TYPES, PERMIT2_WITNESS_TYPE_STRING } from './order';

// SDK-6: the router constants of this package equal the contract's. spec/constants.json is
// written by `npm run sync` from the Solidity source of the evm-contracts commit the ABIs
// come from; a constant changed there and not here fails this test on the next sync.

type Synced = { commit: string; contracts: Record<string, Record<string, { type: string; value: string }>> };
const spec = join(__dirname, '..', 'spec');
const synced = JSON.parse(readFileSync(join(spec, 'constants.json'), 'utf8')) as Synced;
const canton = JSON.parse(readFileSync(join(spec, 'vectors', 'canton-order.json'), 'utf8')).constants as Record<string, unknown>;

const EXPORTED: Record<string, Record<string, number>> = {
  CancoreRouter: { BPS, MAX_FEE_BPS, MIN_FILL_TTL, PROOF_KIND_ATTESTATION },
  AttestorSet: { SET_DELAY, MAX_FILL_TTL, MAX_SIG_TTL, MAX_PROOF_WINDOW, GRACE },
};

test('spec/constants.json was synced from the same evm-contracts commit as the ABIs', () => {
  expect(synced.commit).toBe(CONTRACTS_RELEASE.commit);
});

test.each(Object.entries(EXPORTED).flatMap(([contract, values]) => Object.entries(values).map(([name, value]) => [contract, name, value] as const)))(
  '%s.%s equals the contract',
  (contract, name, value) => {
    const entry = synced.contracts[contract]![name];
    expect([name, entry?.value]).toEqual([name, String(value)]);
  },
);

test('every numeric public constant of the router and AttestorSet is exported: a new one fails here', () => {
  for (const [contract, constants] of Object.entries(synced.contracts)) {
    const numeric = Object.entries(constants).filter(([, c]) => c.type.startsWith('uint')).map(([n]) => n).sort();
    expect([contract, numeric]).toEqual([contract, Object.keys(EXPORTED[contract] ?? {}).sort()]);
  }
});

test('the relations the contract states hold: GRACE = MAX_FILL_TTL + MAX_PROOF_WINDOW, SET_DELAY > MAX_SIG_TTL + GRACE', () => {
  expect(GRACE).toBe(MAX_FILL_TTL + MAX_PROOF_WINDOW);
  expect(SET_DELAY).toBeGreaterThan(MAX_SIG_TTL + GRACE);
  expect([BPS, MAX_FEE_BPS, MIN_FILL_TTL, MAX_FILL_TTL, MAX_SIG_TTL, MAX_PROOF_WINDOW, SET_DELAY]).toEqual([10_000, 1_000, 60, 86_400, 86_400, 14_400, 259_200]);
});

test('the router type hashes equal the type strings of this package (S2)', () => {
  const router = synced.contracts.CancoreRouter!;
  expect(router.ORDER_TYPEHASH!.value).toBe(typeHash(ORDER_TYPES, 'Order'));
  expect(router.QUOTE_TYPEHASH!.value).toBe(typeHash(QUOTE_TYPES, 'Quote'));
  expect(router.TICKET_TYPEHASH!.value).toBe(typeHash(FILL_TICKET_TYPES, 'FillTicket'));
  expect(router.FILLPROOF_TYPEHASH!.value).toBe(typeHash(FILL_PROOF_TYPES, 'FillProof'));
});

test('the Permit2 witness tail is the router\'s WITNESS_TYPE_STRING, and the full type is what a wallet signs', () => {
  expect(PERMIT2_WITNESS_TYPE_STRING).toBe(synced.contracts.CancoreRouter!.WITNESS_TYPE_STRING!.value);
  const stub = 'PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,';
  const types = JSON.parse(JSON.stringify(PERMIT_WITNESS_TYPES)) as Record<string, { name: string; type: string }[]>;
  expect(TypedDataEncoder.from(types).encodeType('PermitWitnessTransferFrom')).toBe(stub + PERMIT2_WITNESS_TYPE_STRING);
});

test('the Canton-source constants equal canton-order.json (evm-contracts test/vectors, Daml intent-test golden)', () => {
  expect(EIP2294_MAX_CHAIN_ID.toString()).toBe(canton.eip2294MaxChainId);
  expect(EIP2294_MAX_CHAIN_ID).toBe((2n ** 64n - 1n) / 2n - 36n);
  expect({ mainnet: String(CANTON_ORIGIN_ID.mainnet), testnet: String(CANTON_ORIGIN_ID.testnet), devnet: String(CANTON_ORIGIN_ID.devnet) }).toEqual(canton.cantonOriginId);
  expect(CANTON_SOURCE_ANCHOR).toBe(canton.cantonSourceAnchor);
  expect(CANTON_SOURCE_ANCHOR).toBe(getAddress(`0x${keccak256(toUtf8Bytes('cancore:canton-source-anchor:v1')).slice(-40)}`));
  expect(OWNER_LABEL_TAG).toBe(canton.ownerLabelTag);
  expect(INSTRUMENT_LABEL_TAG).toBe(canton.instrumentLabelTag);
  expect(DAML_NUMERIC_SCALE).toBe(canton.damlNumericScale);
});

test('exported from the package root (S4)', () => {
  for (const name of [
    'BPS', 'MAX_FEE_BPS', 'MIN_FILL_TTL', 'MAX_FILL_TTL', 'MAX_PROOF_WINDOW', 'GRACE', 'SET_DELAY', 'MAX_SIG_TTL', 'PROOF_KIND_ATTESTATION',
    'CANTON_ORIGIN_ID', 'CANTON_SOURCE_ANCHOR', 'DAML_NUMERIC_SCALE', 'EIP2294_MAX_CHAIN_ID', 'OWNER_LABEL_TAG', 'INSTRUMENT_LABEL_TAG',
    'hashOrder', 'sourceOrderHash', 'buildCantonSourceOrder', 'isCantonOriginId', 'PERMIT_WITNESS_TYPES', 'PERMIT2_WITNESS_TYPE_STRING',
    'permit2Domain', 'hashPermitWitness', 'inclusiveFeeSplit', 'cantonInclusiveFeeSplit',
  ]) expect([name, (pkg as Record<string, unknown>)[name] !== undefined]).toEqual([name, true]);
});
