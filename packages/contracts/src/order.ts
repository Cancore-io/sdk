/**
 * Order hashing of the intent rail: the router's `hashOrder` and
 * `sourceOrderHash`, the EVM-form `Order` of a Canton-source intent
 * (protocol.md §3.7, a port of evm-contracts `test/helpers/cantonOrder.ts`),
 * and the Permit2 witness a maker signs to open an EVM-source intent
 * (`CancoreRouter.WITNESS_TYPE_STRING`). Digests only: signing stays with the
 * consumer's own secp256k1 key.
 */
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils';
import { CANTON_ORIGIN_ID, CANTON_SOURCE_ANCHOR, DAML_NUMERIC_SCALE, EIP2294_MAX_CHAIN_ID, INSTRUMENT_LABEL_TAG, MAX_FEE_BPS, OWNER_LABEL_TAG } from './constants';
import { PERMIT2_ADDRESS } from './deployments';
import { abiEncodeStrings, exactUnits } from './encoding';
import { beBytes, hexBytes, keccak, toHex, uint } from './protocol/bytes';
import { encodeType, hashDomain, hashStruct, hashTypedData } from './protocol/hash';
import { ORDER_TYPES, routerDomain, type Hex, type Order, type UintLike } from './protocol/typedData';

/** The source-router domain an order is hashed in: its chain id and router (Canton: `CANTON_ORIGIN_ID`, `CANTON_SOURCE_ANCHOR`). */
export interface OrderDomain {
  chainId: UintLike;
  verifyingContract: Hex | string;
}

/** `CancoreRouter.hashOrder`: the EIP-712 digest of `order` in the router domain `{chainId, verifyingContract}` — the `orderHash`. */
export function hashOrder(order: Order, domain: OrderDomain): Hex {
  return hashTypedData({ domain: routerDomain(domain.chainId, domain.verifyingContract as Hex), types: ORDER_TYPES, primaryType: 'Order', message: { ...order } });
}

/** Whether `chainId` is the `Order.originChainId` of a Canton network (`CANTON_ORIGIN_ID`). */
export function isCantonOriginId(chainId: UintLike): boolean {
  let id: bigint;
  try {
    id = uint(chainId, 64, 'chainId');
  } catch {
    return false;
  }
  return Object.values(CANTON_ORIGIN_ID).includes(id as (typeof CANTON_ORIGIN_ID)[keyof typeof CANTON_ORIGIN_ID]);
}

/**
 * `CancoreRouter.sourceOrderHash`: the order hash as its SOURCE router computed it — what a destination
 * keys `filled` on. A Canton origin hashes under `CANTON_SOURCE_ANCHOR`; an EVM origin needs the source
 * router registered for it (`sourceRouter[originChainId]`), and is refused without one as the router
 * reverts `SourceRouterUnknown`.
 */
export function sourceOrderHash(order: Order, sourceRouter?: Hex | string): Hex {
  const router = sourceRouter ?? (isCantonOriginId(order.originChainId) ? CANTON_SOURCE_ANCHOR : undefined);
  if (router === undefined) throw new Error(`sourceOrderHash: no source router for originChainId ${String(order.originChainId)} (SourceRouterUnknown)`);
  return hashOrder(order, { chainId: order.originChainId, verifyingContract: router });
}

/** A Canton-source intent as its owner signs it (`SwapIntentRequest`), the input of `buildCantonSourceOrder`. */
export interface CantonSourceIntent {
  /** Canton party id of the owner, e.g. `alice::1220abc…`. */
  ownerPartyId: string;
  /** `requestId` of the signed request; without it two identical requests would share a hash. */
  requestId: string;
  /** Party id of the instrument admin (registry operator). */
  instrumentAdmin: string;
  /** Instrument id inside that registry, e.g. `CNRX`. */
  instrumentId: string;
  /** Amount given (the total T, fee included), a Daml decimal string, at most 10 decimal places. */
  amount: string;
  /** EVM chain the output is delivered on. */
  destinationChainId: UintLike;
  /** ERC-20 delivered there. */
  wantToken: string;
  /** Its `decimals()`. */
  wantDecimals: number;
  /** Lower bound of the delivery, a decimal string in `wantToken` units. */
  minReceived: string;
  /** Receiver on the destination, an EVM address. */
  recipient: string;
  /** The owner-signed `orderCreatedAt` of the request (not the ledger time of Execute), unix seconds, a whole second. */
  createdAt: number | string;
  /** Unix seconds, a whole second. */
  fillDeadline: number | string;
  /** Inclusive fee rate as a decimal string, e.g. `"0.003"`; at most 4 decimal places, at most `MAX_FEE_BPS / 10 000`. */
  feeRate: string;
  /** One of `CANTON_ORIGIN_ID`. */
  cantonOriginId: UintLike;
}

export interface CantonSourceOrder {
  /** The EVM-form `Order`: wide integers as decimal strings, addresses EIP-55, words lowercase. */
  order: Order;
  /** The Canton source domain: `CancoreRouter` v1, `CANTON_ORIGIN_ID`, `CANTON_SOURCE_ANCHOR`. */
  domain: { name: 'CancoreRouter'; version: '1'; chainId: string; verifyingContract: typeof CANTON_SOURCE_ANCHOR };
  orderHash: Hex;
}

/**
 * The EVM-form `Order` of a Canton-source intent and its source-domain hash (protocol.md §3.7).
 * Refuses rather than rounds: an amount, a fee or a time the chain cannot represent exactly is
 * rejected BEFORE the owner signs, because after that the `orderHash` is fixed.
 */
export function buildCantonSourceOrder(intent: CantonSourceIntent): CantonSourceOrder {
  for (const field of ['ownerPartyId', 'requestId', 'instrumentAdmin', 'instrumentId'] as const) {
    if (typeof intent[field] !== 'string' || intent[field].length === 0) throw new TypeError(`${field}: a non-empty string`);
  }
  const originChainId = uint(intent.cantonOriginId, 64, 'cantonOriginId');
  if (originChainId <= EIP2294_MAX_CHAIN_ID) throw new RangeError(`cantonOriginId: ${originChainId} collides with the EVM chain-id range`);
  const feeBps = exactUnits(intent.feeRate, 4, 'feeRate');
  if (feeBps > BigInt(MAX_FEE_BPS)) throw new RangeError(`feeRate: ${intent.feeRate} exceeds MAX_FEE_BPS`);

  const order: Order = {
    user: label(OWNER_LABEL_TAG, intent.ownerPartyId, intent.requestId),
    originChainId: originChainId.toString(),
    inputToken: label(INSTRUMENT_LABEL_TAG, intent.instrumentAdmin, intent.instrumentId),
    inputAmount: exactUnits(intent.amount, DAML_NUMERIC_SCALE, 'amount').toString(),
    destination: toHex(beBytes(uint(intent.destinationChainId, 256, 'destinationChainId'), 32)),
    outputAsset: addressWord(intent.wantToken, 'wantToken'),
    minReceived: exactUnits(intent.minReceived, intent.wantDecimals, 'minReceived').toString(),
    recipient: addressWord(intent.recipient, 'recipient'),
    createdAt: wholeSecond(intent.createdAt, 'createdAt'),
    fillDeadline: wholeSecond(intent.fillDeadline, 'fillDeadline'),
    feeBps: feeBps.toString(),
  };
  const domain = { name: 'CancoreRouter', version: '1', chainId: originChainId.toString(), verifyingContract: CANTON_SOURCE_ANCHOR } as const;
  return { order, domain, orderHash: hashOrder(order, domain) };
}

/** `TokenPermissions(address token,uint256 amount)` of Permit2. */
const TOKEN_PERMISSIONS_TYPES = {
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
} as const;

/**
 * `CancoreRouter.WITNESS_TYPE_STRING`: the tail Permit2 appends after
 * `"PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,"`.
 */
export const PERMIT2_WITNESS_TYPE_STRING = `Order witness)${encodeType(ORDER_TYPES, 'Order')}${encodeType(TOKEN_PERMISSIONS_TYPES, 'TokenPermissions')}`;

const PERMIT_WITNESS_TYPEHASH = keccak(
  utf8ToBytes(`PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,${PERMIT2_WITNESS_TYPE_STRING}`),
);

/** The Permit2 witness typed data a wallet renders and signs (`eth_signTypedData_v4` types), the `Order` nested as `witness`. */
export const PERMIT_WITNESS_TYPES = {
  PermitWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'witness', type: 'Order' },
  ],
  ...TOKEN_PERMISSIONS_TYPES,
  ...ORDER_TYPES,
} as const;

/** The message of `PERMIT_WITNESS_TYPES`: `spender` is the source router, `permitted` the order's input token and amount. */
export interface PermitWitness {
  permitted: { token: Hex | string; amount: UintLike };
  spender: Hex | string;
  nonce: UintLike;
  deadline: UintLike;
  witness: Order;
}

/** The Permit2 domain: `{name: "Permit2", chainId, verifyingContract}` — no version. */
export function permit2Domain(chainId: UintLike, permit2: Hex | string = PERMIT2_ADDRESS) {
  return { name: 'Permit2', chainId, verifyingContract: permit2 } as const;
}

/** The digest the maker signs for `openFor`: `PermitWitnessTransferFrom` with the order as witness, in the Permit2 domain. */
export function hashPermitWitness(permit: PermitWitness, chainId: UintLike, permit2: Hex | string = PERMIT2_ADDRESS): Hex {
  const struct = keccak(
    concatBytes(
      PERMIT_WITNESS_TYPEHASH,
      hexBytes(hashStruct(TOKEN_PERMISSIONS_TYPES, 'TokenPermissions', permit.permitted), 'permitted', 32),
      hexBytes(addressWord(permit.spender, 'spender'), 'spender', 32),
      beBytes(uint(permit.nonce, 256, 'nonce'), 32),
      beBytes(uint(permit.deadline, 256, 'deadline'), 32),
      hexBytes(hashStruct(ORDER_TYPES, 'Order', { ...permit.witness }), 'witness', 32),
    ),
  );
  const separator = hexBytes(hashDomain(permit2Domain(chainId, permit2)), 'domain', 32);
  return toHex(keccak(concatBytes(new Uint8Array([0x19, 0x01]), separator, struct)));
}

// --- encoding helpers

/** Unix seconds as a whole second (a safe integer or a canonical decimal string), within uint64. */
function wholeSecond(value: unknown, field: string): string {
  return uint(value, 64, `${field} (a whole second)`).toString();
}

/** An EVM address as the left-padded lowercase 32-byte word of `bytes32(uint256(uint160(address)))`. */
function addressWord(value: unknown, field: string): Hex {
  const address = checksumAddress(value, field);
  return `0x${'00'.repeat(12)}${address.slice(2).toLowerCase()}`;
}

/** EIP-55; a mixed-case input must already carry the right checksum, as ethers `getAddress` requires. */
function checksumAddress(value: unknown, field: string): Hex {
  hexBytes(value, field, 20);
  const lower = (value as string).slice(2).toLowerCase();
  const hash = toHex(keccak(utf8ToBytes(lower))).slice(2);
  const sum = `0x${[...lower].map((c, i) => (parseInt(hash[i]!, 16) >= 8 ? c.toUpperCase() : c)).join('')}` as Hex;
  const body = (value as string).slice(2);
  if (body !== body.toLowerCase() && body !== body.toUpperCase() && `0x${body}` !== sum) throw new TypeError(`${field}: bad EIP-55 checksum: ${String(value)}`);
  return sum;
}

/** `address(uint160(uint256(keccak256(abi.encode(tag, a, b)))))`, EIP-55 — the owner and instrument labels. */
function label(tag: string, a: string, b: string): Hex {
  const hash = toHex(keccak(abiEncodeStrings([tag, a, b])));
  return checksumAddress(`0x${hash.slice(-40)}`, 'label');
}
