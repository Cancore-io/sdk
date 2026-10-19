/**
 * A Canton-form ticket (CAN-1867): the order's Canton destination, the
 * `DeliveryOrder` held to the ticket and the offered order, and the
 * `CantonTicketReceipt` the filler signs. The chain checks (V-E1…V-E5) run
 * against the real router on the stand: `test/canton-delivery.int.test.ts`.
 */
import {
  cantonTicketReceipt,
  encodeCantonAmount,
  encodeCantonDestination,
  encodeCantonOutputAsset,
  encodeCantonRecipient,
  hashCantonTicketReceipt,
  type CantonDeliveryOrder,
  type Hex,
  type TicketIssuedCanton,
} from '@cancore/contracts';
import { recoverAddress } from '../signer';
import { createTestTypedDataSigner } from '../testing';
import { deliveryOrderMismatch } from './canton-ticket';
import { chainsOf, signCantonTicketReceipt } from './terms';

const MESSAGE_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const asset = { admin: 'cancore::1220aa', id: 'CNRX' };
const RECIPIENT = 'alice::1220cd';
const issued: TicketIssuedCanton = {
  type: 'ticket.issued', form: 'canton', id: 'f-1', fillerId: 'cancore-dev-1', ts: 0, msgSig: '0x', orderHash: `0x${'5a'.repeat(32)}`, attempt: 2,
  deliveryOrderCid: `00${'0d'.repeat(33)}`, validUntil: '1790000120', repayTo: `0x${'00'.repeat(12)}${'7e'.repeat(20)}`,
} as unknown as TicketIssuedCanton;
const order: CantonDeliveryOrder = {
  deliveryOrderCid: issued.deliveryOrderCid, orderHash: issued.orderHash, attempt: 2, asset, amount: '25.0000000000', recipient: RECIPIENT, repayTo: issued.repayTo, validUntil: issued.validUntil,
};
const offered = { recipient: encodeCantonRecipient(RECIPIENT), outputAsset: encodeCantonOutputAsset(asset) };
const bounds = { minReceived: encodeCantonAmount('25'), amountOut: encodeCantonAmount('25') };

describe('the order’s Canton destination (CAN-1867)', () => {
  test('TC-SDK-1867-30: keccak256("canton:devnet") is a Canton destination, never an eip155 chain, whatever its top bit', () => {
    const chains = chainsOf({ originChainId: '11155111', destination: encodeCantonDestination('devnet') } as never);
    expect(chains).toEqual({ origin: 11155111n, source: 'eip155:11155111', canton: 'devnet' });
    expect(chainsOf({ originChainId: '11155111', destination: `0x${'00'.repeat(31)}01` } as never)).toEqual({ origin: 11155111n, source: 'eip155:11155111', destination: 'eip155:1' });
  });
});

describe('the DeliveryOrder of a Canton-form ticket (CAN-1867)', () => {
  test('TC-SDK-1867-31: the DeliveryOrder that repeats the ticket and the order passes', () => {
    expect(deliveryOrderMismatch(order, issued, offered, bounds)).toBeUndefined();
  });

  test.each([
    ['another order', { orderHash: `0x${'5b'.repeat(32)}` }, 'orderHash'],
    ['another attempt', { attempt: 3 }, 'attempt'],
    ['another validUntil', { validUntil: '1790000180' }, 'validUntil'],
    ['T-48: another repayTo than the signed ticket.intent', { repayTo: `0x${'00'.repeat(12)}${'66'.repeat(20)}` }, 'repayTo'],
    ['another recipient', { recipient: 'mallory::1220ee' }, 'recipient'],
    ['another instrument', { asset: { ...asset, id: 'CC' } }, 'asset'],
    ['an amount below minReceived', { amount: '24.9999999999' }, 'amount'],
    ['an amount above the filler’s quote', { amount: '25.0000000001' }, 'amount'],
    ['an amount not exact at 10⁻¹⁰', { amount: '25.00000000001' }, 'amount'],
  ])('TC-SDK-1867-32: %s is a mismatch', (_name, over, field) => {
    expect(deliveryOrderMismatch({ ...order, ...over } as CantonDeliveryOrder, issued, offered, bounds)).toBe(field);
  });
});

describe('the Canton-form receipt (CAN-1867, T-22)', () => {
  test('TC-SDK-1867-33: ticket.receipt {form: "canton"} carries the ticket’s fields and a CantonTicketReceipt signature by the message key', async () => {
    const signer = createTestTypedDataSigner(MESSAGE_KEY);
    const receipt = await signCantonTicketReceipt(issued, signer, 'r-1');
    expect(receipt).toMatchObject({ type: 'ticket.receipt', form: 'canton', orderHash: issued.orderHash, attempt: 2, deliveryOrderCid: issued.deliveryOrderCid, validUntil: issued.validUntil });
    expect(receipt).not.toHaveProperty('ticketHash');
    expect(recoverAddress(hashCantonTicketReceipt(cantonTicketReceipt(issued)), receipt.sig)).toBe(signer.address.toLowerCase());
  });
});
