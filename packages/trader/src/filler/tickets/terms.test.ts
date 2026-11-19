import {
  CANTON_ORIGIN_ID, encodeCantonDestination, fillerIdHash, repayToFromEvm, repayToFromParty,
  type Hex, type OrderJson, type TicketJson, type TicketReceiptMessage,
} from '@cancore/contracts';
import type { FillSigner } from '../signer';
import type { TicketRecord } from '../store';
import { CANTON_ORIGIN_FLOOR, chainsOf, identityFor, isBoundToDeliver, ticketMismatch, type OfferTerms, type TicketKeys } from './terms';

const SRC_KEY = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Hex;
const DST_KEY = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Hex;
const PARTY = 'filler::1220abcd';
const ORDER_HASH = `0x${'ab'.repeat(32)}` as Hex;

const signer = (address: Hex) => ({ address }) as unknown as FillSigner;
const word = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const order = (originChainId: bigint, destination: Hex): OrderJson => ({ originChainId: originChainId.toString(), destination }) as unknown as OrderJson;

const KEYS: TicketKeys = { fillerId: 'acme-1', fillSigners: { 'eip155:1': signer(SRC_KEY), 'eip155:10': signer(DST_KEY) }, cantonParty: PARTY };

describe('chainsOf: the chains an order names', () => {
  test('EVM to EVM: origin and destination below 2⁶³ are eip155 chains', () => {
    expect(chainsOf(order(1n, word(10n)))).toEqual({ origin: 1n, source: 'eip155:1', destination: 'eip155:10' });
  });

  test('the last EVM id below 2⁶³ is EVM; 2⁶³ itself is neither an EVM source nor an EVM destination', () => {
    const last = CANTON_ORIGIN_FLOOR - 1n;
    expect(chainsOf(order(last, word(last)))).toEqual({ origin: last, source: `eip155:${last}`, destination: `eip155:${last}` });
    expect(chainsOf(order(CANTON_ORIGIN_FLOOR, word(CANTON_ORIGIN_FLOOR)))).toEqual({ origin: CANTON_ORIGIN_FLOOR });
  });

  test('a Canton origin has no EVM source; zero is no chain at all', () => {
    expect(chainsOf(order(CANTON_ORIGIN_ID.devnet, word(1n)))).toEqual({ origin: CANTON_ORIGIN_ID.devnet, destination: 'eip155:1' });
    expect(chainsOf(order(0n, word(0n)))).toEqual({ origin: 0n });
  });

  test.each(Object.keys(CANTON_ORIGIN_ID) as (keyof typeof CANTON_ORIGIN_ID)[])('a Canton %s destination is Canton, never an EVM chain', (network) => {
    expect(chainsOf(order(1n, encodeCantonDestination(network)))).toEqual({ origin: 1n, source: 'eip155:1', canton: network });
  });

  test.each([
    ['origin not decimal', { originChainId: '0x1', destination: word(1n) }],
    ['origin with a leading zero', { originChainId: '01', destination: word(1n) }],
    ['origin a number', { originChainId: 1, destination: word(1n) }],
    ['destination short', { originChainId: '1', destination: `0x${'00'.repeat(31)}` }],
    ['destination not hex', { originChainId: '1', destination: `0x${'zz'.repeat(32)}` }],
  ])('%s: undefined', (_name, json) => {
    expect(chainsOf(json as unknown as OrderJson)).toBeUndefined();
  });
});

describe('identityFor: who the filler is in a ticket', () => {
  test('EVM to EVM: the destination fill key delivers, the source fill key is paid', () => {
    expect(identityFor(order(1n, word(10n)), KEYS)).toEqual({
      chain: 'eip155:10', signer: KEYS.fillSigners['eip155:10'], fillerId: 'acme-1', deliveryKey: DST_KEY.toLowerCase(), repayTo: repayToFromEvm(SRC_KEY),
    });
  });

  test('no fill key on the source chain: the destination key is paid there too', () => {
    const identity = identityFor(order(137n, word(10n)), KEYS);
    expect(identity?.repayTo).toBe(repayToFromEvm(DST_KEY));
  });

  test('EVM to Canton: the source key runs the attempt, the delivery key is the zero address', () => {
    const identity = identityFor(order(1n, encodeCantonDestination('devnet')), KEYS);
    expect(identity).toMatchObject({ chain: 'eip155:1', deliveryKey: `0x${'00'.repeat(20)}`, repayTo: repayToFromEvm(SRC_KEY) });
  });

  test('Canton to EVM: paid to the hash of the filler party', () => {
    expect(identityFor(order(CANTON_ORIGIN_ID.devnet, word(10n)), KEYS)?.repayTo).toBe(repayToFromParty(PARTY));
  });

  test.each([
    ['no fill key for the destination', order(1n, word(56n)), KEYS],
    ['no party on a Canton source', order(CANTON_ORIGIN_ID.devnet, word(10n)), { ...KEYS, cantonParty: undefined }],
    ['no EVM chain on either side', order(CANTON_ORIGIN_ID.devnet, encodeCantonDestination('devnet')), KEYS],
    ['an order that does not parse', order(1n, '0x01' as Hex), KEYS],
  ])('%s: undefined', (_name, json, keys) => {
    expect(identityFor(json, keys)).toBeUndefined();
  });
});

describe('ticketMismatch: the first field an issued ticket does not repeat', () => {
  const identity = identityFor(order(1n, word(10n)), KEYS)!;
  const terms: OfferTerms = { orderHash: ORDER_HASH, attempt: 2, validFrom: '1790000000', validUntil: '1790000300' };
  const ticket: TicketJson = {
    orderHash: ORDER_HASH.toUpperCase().replace('0X', '0x') as Hex, attempt: 2, validFrom: '1790000000', validUntil: '1790000300',
    fillerId: fillerIdHash('acme-1').toUpperCase().replace('0X', '0x') as Hex, deliveryKey: DST_KEY, repayTo: identity.repayTo,
  } as TicketJson;

  test('a ticket that repeats every term, in any letter case, matches', () => {
    expect(ticketMismatch(ticket, terms, identity)).toBeUndefined();
  });

  test.each([
    ['ticket', null],
    ['orderHash', { ...ticket, orderHash: `0x${'cd'.repeat(32)}` }],
    ['attempt', { ...ticket, attempt: 3 }],
    ['attempt', { ...ticket, attempt: '2' }],
    ['validFrom', { ...ticket, validFrom: '1790000001' }],
    ['validUntil', { ...ticket, validUntil: '1790000301' }],
    ['fillerId', { ...ticket, fillerId: fillerIdHash('acme-2') }],
    ['deliveryKey', { ...ticket, deliveryKey: SRC_KEY }],
    ['repayTo', { ...ticket, repayTo: repayToFromEvm(DST_KEY) }],
  ])('%s', (field, issued) => {
    expect(ticketMismatch(issued as unknown as TicketJson, terms, identity)).toBe(field);
  });
});

describe('isBoundToDeliver: only a receipt handed to filler-gateway binds the filler', () => {
  const receipt = { type: 'ticket.receipt' } as unknown as TicketReceiptMessage;
  const bound: TicketRecord = { orderHash: ORDER_HASH, attempt: 0, state: 'receipted', receipt, sentAtMs: 5, updatedAtMs: 5 };

  test('receipted, sent and not abandoned', () => {
    expect(isBoundToDeliver(bound)).toBe(true);
  });

  test.each([
    ['still checking', { ...bound, state: 'checking' as const }],
    ['receipt written, not yet sent', { ...bound, sentAtMs: undefined }],
    ['receipt never went out', { ...bound, unsent: true as const }],
    ['no receipt', { ...bound, receipt: undefined }],
  ])('%s: not bound', (_name, record) => {
    expect(isBoundToDeliver(record)).toBe(false);
  });
});
