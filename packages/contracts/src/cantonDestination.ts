/**
 * Canton-destination orders and proofs in EVM form (protocol.md §3.13): an
 * EVM-source order whose output is delivered on Canton, and the `FillProof` of
 * that delivery, carry Canton values in EVM fields. This is the one encoder the
 * backend OrderBuilder, the web app, the filler node and the attestors use;
 * nobody re-implements it.
 */
import { utf8ToBytes } from '@noble/hashes/utils';
import { CANTON_ORIGIN_ID, DAML_NUMERIC_SCALE, INSTRUMENT_LABEL_TAG } from './constants';
import { abiEncodeStrings, exactUnits } from './encoding';
import { keccak, toHex } from './protocol/bytes';
import type { Hex } from './protocol/typedData';

/** A Canton network, as in its CAIP-2 id `canton:<network>`. */
export type CantonNetwork = keyof typeof CANTON_ORIGIN_ID;

const NETWORKS = Object.keys(CANTON_ORIGIN_ID) as CantonNetwork[];

const utf8Hash = (text: string): Hex => toHex(keccak(utf8ToBytes(text)));

const nonEmpty = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${field}: a non-empty string`);
  return value;
};

/** `Order.destination` and `FillProof.destination` of a Canton network: `keccak256(utf8("canton:<network>"))`. */
export function encodeCantonDestination(network: CantonNetwork): Hex {
  if (!NETWORKS.includes(network)) throw new TypeError(`network: one of ${NETWORKS.join(', ')}, got ${JSON.stringify(network)}`);
  return utf8Hash(`canton:${network}`);
}

/** The Canton network an order's `destination` names, or `undefined` when it is not a Canton destination. */
export function cantonNetworkOfDestination(destination: string): CantonNetwork | undefined {
  const word = typeof destination === 'string' ? destination.toLowerCase() : '';
  return NETWORKS.find((network) => encodeCantonDestination(network) === word);
}

/**
 * `Order.outputAsset` and `FillProof.outputAsset` of a Canton instrument:
 * `keccak256(abi.encode("cancore:instrument:v1", admin, id))`, the full 32 bytes — the same hash a
 * Canton-source `inputToken` label truncates to 20 bytes.
 */
export function encodeCantonOutputAsset(instrument: { admin: string; id: string }): Hex {
  return toHex(keccak(abiEncodeStrings([INSTRUMENT_LABEL_TAG, nonEmpty(instrument.admin, 'instrument.admin'), nonEmpty(instrument.id, 'instrument.id')])));
}

/** `Order.recipient` and `FillProof.recipient` of a Canton party: `keccak256(utf8(partyId))` over the full party id. */
export function encodeCantonRecipient(partyId: string): Hex {
  return utf8Hash(nonEmpty(partyId, 'partyId'));
}

/**
 * `Order.minReceived` and `FillProof.amountDelivered` of a Canton amount: the Daml `Numeric 10`
 * decimal × 10¹⁰. No rounding: an amount that is not exact at 10⁻¹⁰ is refused before anyone signs.
 */
export function encodeCantonAmount(amount: string): bigint {
  return exactUnits(amount, DAML_NUMERIC_SCALE, 'amount');
}
