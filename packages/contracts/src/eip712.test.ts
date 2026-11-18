import { CANTON_ORIGIN_ID, CANTON_SOURCE_ANCHOR, EIP2294_MAX_CHAIN_ID } from './constants';
import { FEE_CLAIM_TYPES, feeClaimDomain, fillProofDomain } from './eip712';
import { FILL_PROOF_DOMAIN, FILL_PROOF_TYPES } from './generated/typedData';
import { hashDomain, hashTypedData, typeHash, type TypedDataDomain, type TypedDataTypes } from './protocol/hash';
import {
  CANTON_TICKET_RECEIPT_TYPES, FILL_TICKET_DOMAIN, FILL_TICKET_TYPES, FILLER_AUTH_TYPES, FILLER_KEY_REGISTRATION_TYPES, FILLER_MESSAGE_TYPES,
  FILLER_PROTOCOL_DOMAIN, FILLER_QUOTE_TYPES, GATEWAY_MESSAGE_TYPES, ORDER_TYPES, QUOTE_TYPES, routerDomain, STAKE_BINDING_TYPES,
  TICKET_INTENT_TYPES, TICKET_RECEIPT_TYPES,
} from './protocol/typedData';

const ROUTER = '0x1111111111111111111111111111111111111111';
const OTHER_ROUTER = '0x2222222222222222222222222222222222222222';

/** The thirteen protocol types and FeeClaim, each with the domain family its digests are computed in. */
const TYPES: [string, TypedDataTypes, string][] = [
  ['Order', ORDER_TYPES, 'router'],
  ['Quote', QUOTE_TYPES, 'router'],
  ['FillProof', FILL_PROOF_TYPES, 'router'],
  ['FillTicket', FILL_TICKET_TYPES, 'ticket'],
  ['FillerQuote', FILLER_QUOTE_TYPES, 'filler'],
  ['TicketIntent', TICKET_INTENT_TYPES, 'filler'],
  ['TicketReceipt', TICKET_RECEIPT_TYPES, 'filler'],
  ['CantonTicketReceipt', CANTON_TICKET_RECEIPT_TYPES, 'filler'],
  ['StakeBinding', STAKE_BINDING_TYPES, 'filler'],
  ['FillerAuth', FILLER_AUTH_TYPES, 'filler'],
  ['GatewayMessage', GATEWAY_MESSAGE_TYPES, 'filler'],
  ['FillerMessage', FILLER_MESSAGE_TYPES, 'filler'],
  ['FillerKeyRegistration', FILLER_KEY_REGISTRATION_TYPES, 'filler'],
  ['FeeClaim', FEE_CLAIM_TYPES, 'fee-vault'],
];

describe('domain separation of the EIP-712 types', () => {
  test('every type has its own type hash, so no struct hash of one type is a struct hash of another', () => {
    const hashes = TYPES.map(([name, types]) => typeHash(types, name));
    expect(TYPES).toHaveLength(14);
    expect(new Set(hashes).size).toBe(TYPES.length);
  });

  test('the four domain families have four separators', () => {
    const separators = [
      hashDomain(routerDomain(1, ROUTER)),
      hashDomain(FILL_TICKET_DOMAIN),
      hashDomain(FILLER_PROTOCOL_DOMAIN),
      hashDomain(feeClaimDomain(1, ROUTER)),
    ];
    expect(new Set(separators).size).toBe(4);
  });

  test('Order, Quote and FillProof share the router domain: one source router, one separator; another chain or router, another', () => {
    expect(FILL_PROOF_DOMAIN).toEqual({ name: routerDomain(1, ROUTER).name, version: routerDomain(1, ROUTER).version });
    expect(hashDomain(fillProofDomain(1, ROUTER))).toBe(hashDomain(routerDomain(1, ROUTER)));
    const domains: TypedDataDomain[] = [
      routerDomain(1, ROUTER),
      routerDomain(1, OTHER_ROUTER),
      routerDomain(11155111, ROUTER),
      routerDomain(EIP2294_MAX_CHAIN_ID, ROUTER),
      ...Object.values(CANTON_ORIGIN_ID).map((id) => routerDomain(id, CANTON_SOURCE_ANCHOR)),
    ];
    expect(new Set(domains.map(hashDomain)).size).toBe(domains.length);
  });

  test('every Canton origin id is above every EVM chain id EIP-2294 allows, so no EVM domain is a Canton domain', () => {
    for (const id of Object.values(CANTON_ORIGIN_ID)) expect(id > EIP2294_MAX_CHAIN_ID).toBe(true);
    expect(new Set(Object.values(CANTON_ORIGIN_ID)).size).toBe(3);
  });
});

describe('a string member of a typed struct', () => {
  const quote = (fillerId: string) => ({
    domain: FILLER_PROTOCOL_DOMAIN,
    types: FILLER_QUOTE_TYPES,
    primaryType: 'FillerQuote',
    message: { requestId: `0x${'ab'.repeat(32)}`, fillerId, amountOut: 1n, validUntil: 1n, nonce: 1n },
  });

  test('is refused with a lone surrogate: its digest would equal the digest of the string with U+FFFD', () => {
    expect(() => hashTypedData(quote('acme\ud800'))).toThrow(/lone surrogate/);
    expect(() => hashTypedData({ domain: { name: 'x\udfff', version: '1' }, types: FILLER_QUOTE_TYPES, primaryType: 'FillerQuote', message: quote('acme').message })).toThrow(/lone surrogate/);
  });

  test('a type or field name with a lone surrogate is refused as well', () => {
    const named = (name: string): TypedDataTypes => ({ [name]: [{ name: 'v\ud800', type: 'uint64' }] });
    expect(() => typeHash(named('T'), 'T')).toThrow(/lone surrogate/);
    expect(() => hashTypedData({ domain: FILLER_PROTOCOL_DOMAIN, types: named('T\udc00'), primaryType: 'T\udc00', message: { 'v\ud800': 1n } })).toThrow(/lone surrogate/);
  });

  test('a non-BMP character is a well-formed pair and hashes apart from U+FFFD', () => {
    expect(hashTypedData(quote('acme😀'))).not.toBe(hashTypedData(quote('acme�')));
  });
});
