import { AbiCoder, keccak256, toUtf8Bytes, TypedDataEncoder } from 'ethers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pkg from './index';
import {
  cantonNetworkOfDestination, encodeCantonAmount, encodeCantonDestination, encodeCantonOutputAsset, encodeCantonRecipient,
} from './cantonDestination';
import { CANTON_ORIGIN_ID, INSTRUMENT_LABEL_TAG } from './constants';
import { FILL_PROOF_TYPES, hashFillProof, type FillProof } from './eip712';
import { hashOrder } from './order';
import type { Hex, Order } from './protocol/typedData';

// An EVM-source order whose output is delivered on Canton, and the FillProof of
// that delivery, carry Canton values in EVM fields (protocol.md §3.13). One
// encoder serves OrderBuilder, the web app, the filler node and the attestors.

const spec = join(__dirname, '..', 'spec');
const load = <T>(...p: string[]): T => JSON.parse(readFileSync(join(spec, ...p), 'utf8')) as T;
type Input = { network: 'devnet'; instrumentAdmin: string; instrumentId: string; minReceived: string; amountDelivered: string; recipientPartyId: string };
type Vector = {
  networks: Record<string, Hex>;
  input: Input;
  encoded: { destination: Hex; outputAsset: Hex; minReceived: string; recipient: Hex; amountDelivered: string };
  domain: { chainId: number | string; verifyingContract: Hex };
  order: Order;
  orderHash: Hex;
  proof: FillProof;
  structHash: Hex;
  digest: Hex;
};
const v = load<{ vector: Vector }>('vectors', 'canton-destination.json').vector;
const fillProof = load<{ vectors: { note: string; chainId: number; verifyingContract: Hex; message: FillProof; digest: Hex }[] }>('typed-data', 'FillProof.json');
const cantonOrder = load<{ vector: { input: Record<string, string>; order: Order } }>('vectors', 'canton-order.json').vector;

describe('the encoder', () => {
  test('destination is keccak256(utf8("canton:<network>")); devnet is the operator decision (Р-3)', () => {
    expect(encodeCantonDestination('devnet')).toBe(keccak256(toUtf8Bytes('canton:devnet')));
    for (const network of Object.keys(CANTON_ORIGIN_ID) as (keyof typeof CANTON_ORIGIN_ID)[]) {
      expect(encodeCantonDestination(network)).toBe(v.networks[network]);
      expect(cantonNetworkOfDestination(v.networks[network]!)).toBe(network);
      expect(cantonNetworkOfDestination(v.networks[network]!.toUpperCase().replace('0X', '0x'))).toBe(network);
    }
    expect(new Set(Object.values(v.networks)).size).toBe(3);
    expect(cantonNetworkOfDestination(`0x${'00'.repeat(31)}01`)).toBeUndefined(); // chain id 1: an EVM destination
    expect(() => encodeCantonDestination('canton:devnet' as never)).toThrow();
    expect(() => encodeCantonDestination('Devnet' as never)).toThrow();
  });

  test('outputAsset is keccak256(abi.encode("cancore:instrument:v1", admin, id)), the full 32 bytes', () => {
    const asset = encodeCantonOutputAsset({ admin: v.input.instrumentAdmin, id: v.input.instrumentId });
    expect(asset).toBe(keccak256(AbiCoder.defaultAbiCoder().encode(['string', 'string', 'string'], [INSTRUMENT_LABEL_TAG, v.input.instrumentAdmin, v.input.instrumentId])));
    expect(asset).toBe(v.encoded.outputAsset);
    expect(encodeCantonOutputAsset({ admin: v.input.instrumentAdmin, id: `${v.input.instrumentId}X` })).not.toBe(asset);
    expect(encodeCantonOutputAsset({ admin: `${v.input.instrumentAdmin}0`, id: v.input.instrumentId })).not.toBe(asset);
    expect(() => encodeCantonOutputAsset({ admin: '', id: 'USDCX' })).toThrow();
  });

  test('the instrument hash is the Canton-source inputToken label before truncation (canton-order.json)', () => {
    const asset = encodeCantonOutputAsset({ admin: cantonOrder.input.instrumentAdmin!, id: cantonOrder.input.instrumentId! });
    expect(asset.slice(-40)).toBe((cantonOrder.order.inputToken as string).slice(2).toLowerCase());
  });

  test('recipient is keccak256(utf8(partyId)) over the full party id', () => {
    expect(encodeCantonRecipient(v.input.recipientPartyId)).toBe(keccak256(toUtf8Bytes(v.input.recipientPartyId)));
    expect(encodeCantonRecipient(v.input.recipientPartyId)).toBe(v.encoded.recipient);
    expect(encodeCantonRecipient(`${v.input.recipientPartyId}0`)).not.toBe(v.encoded.recipient);
    expect(encodeCantonRecipient(v.input.recipientPartyId.split('::')[0]!)).not.toBe(v.encoded.recipient); // the hint alone is not the party
    expect(() => encodeCantonRecipient('')).toThrow();
  });

  test('amounts are Daml Numeric 10 × 10¹⁰, exact or refused', () => {
    expect(encodeCantonAmount(v.input.minReceived)).toBe(BigInt(v.encoded.minReceived));
    expect(encodeCantonAmount(v.input.amountDelivered)).toBe(BigInt(v.encoded.amountDelivered));
    expect(encodeCantonAmount('1200.25')).toBe(12_002_500_000_000n);
    expect(encodeCantonAmount('0.0000000001')).toBe(1n);
    for (const bad of ['1200.25000000001', '-1', '1e3', '', '1,5', ' 1']) expect(() => encodeCantonAmount(bad)).toThrow();
  });

  test('exported from the package root (S4)', () => {
    for (const name of ['encodeCantonDestination', 'cantonNetworkOfDestination', 'encodeCantonOutputAsset', 'encodeCantonRecipient', 'encodeCantonAmount']) {
      expect([name, typeof (pkg as Record<string, unknown>)[name]]).toEqual([name, 'function']);
    }
  });
});

describe('canton-destination.json: an EVM-source order to Canton devnet and the FillProof of its delivery', () => {
  test('the order carries the encoded words; its orderHash is the source router\'s', () => {
    expect(v.order).toMatchObject({ destination: v.encoded.destination, outputAsset: v.encoded.outputAsset, minReceived: v.encoded.minReceived, recipient: v.encoded.recipient });
    expect(v.encoded.destination).toBe(encodeCantonDestination(v.input.network));
    expect(hashOrder(v.order, v.domain)).toBe(v.orderHash);
  });

  test('the proof copies destination, recipient and outputAsset from the order (CancoreRouter.settle checks them) and names the order', () => {
    for (const field of ['destination', 'recipient', 'outputAsset'] as const) expect(v.proof[field]).toBe(v.order[field]);
    expect(v.proof.orderHash).toBe(v.orderHash);
    expect(BigInt(v.proof.amountDelivered)).toBeGreaterThanOrEqual(BigInt(v.order.minReceived));
  });

  test('the FillProof digest: the shipped hashFillProof and ethers agree', () => {
    expect(hashFillProof(v.proof, BigInt(v.domain.chainId), v.domain.verifyingContract)).toBe(v.digest);
    const types = JSON.parse(JSON.stringify(FILL_PROOF_TYPES)) as Record<string, { name: string; type: string }[]>;
    const domain = { name: 'CancoreRouter', version: '1', chainId: v.domain.chainId, verifyingContract: v.domain.verifyingContract };
    expect(TypedDataEncoder.hash(domain, types, v.proof)).toBe(v.digest);
    expect(TypedDataEncoder.hashStruct('FillProof', types, v.proof)).toBe(v.structHash);
  });

  test('the router-pinned Canton-destination vector of FillProof.json (canton:mainnet) is this encoding: only the network differs', () => {
    const pinned = fillProof.vectors.find((x) => x.note.startsWith('Canton destination'))!;
    expect(pinned.message.destination).toBe(encodeCantonDestination('mainnet'));
    expect(pinned.message.recipient).toBe(encodeCantonRecipient(cantonOrder.input.ownerPartyId!));
    expect(pinned.message.outputAsset).toBe(encodeCantonOutputAsset({ admin: cantonOrder.input.instrumentAdmin!, id: cantonOrder.input.instrumentId! }));
    expect(String(pinned.message.amountDelivered)).toBe(String(encodeCantonAmount('1200.25')));
    expect({ ...v.proof, destination: pinned.message.destination }).not.toEqual(v.proof);
    expect(v.proof.recipient).toBe(pinned.message.recipient);
    expect(v.proof.outputAsset).toBe(pinned.message.outputAsset);
  });
});
