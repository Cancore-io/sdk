/**
 * The filler's identity and payout address in on-chain form, and the shape of
 * a message-key signature (protocol §3.1, §3.15, §3.16). Everyone who writes
 * or reads `fillerId` and `repayTo` — trading, filler-gateway, the attestors,
 * the filler SDK — encodes them here, so a ticket, a `Filled` event and a
 * `FillProof` always carry the same 32 bytes. No secp256k1: recovering the
 * signer stays with the consumer's own library.
 */
import { utf8ToBytes } from '@noble/hashes/utils';
import { hexBytes, keccak, toHex } from './bytes';
import type { Hex } from './typedData';

/** `fillerId`: issued by Cancore at onboarding, ASCII so the draw's UTF-8 byte order is plain byte order (D-H). */
export const FILLER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** secp256k1 group order; a message-key signature has `0 < r < N` and `0 < s ≤ N / 2` (low-s). */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** The on-chain form of a filler id, `keccak256(utf8(fillerId))` — `FillTicket`, `Filled`, `FillProof`, `Settled`. */
export function fillerIdHash(fillerId: string): Hex {
  if (typeof fillerId !== 'string' || !FILLER_ID_PATTERN.test(fillerId)) throw new TypeError(`fillerId must match ${FILLER_ID_PATTERN}: ${JSON.stringify(fillerId)}`);
  return toHex(keccak(utf8ToBytes(fillerId)));
}

/**
 * `repayTo` for an EVM source: the address left-padded with zeros to 32 bytes.
 * Refuses the zero address, which `settle` refuses too (`ZeroAddress`).
 */
export function repayToFromEvm(address: string): Hex {
  const bytes = hexBytes(address, 'repayTo address', 20);
  if (bytes.every((b) => b === 0)) throw new RangeError('repayTo: the zero address is not a payee');
  return `0x${'00'.repeat(12)}${address.slice(2).toLowerCase()}`;
}

/** `repayTo` for a Canton source: `keccak256(utf8(partyId))` of the filler's party registered under its `fillerId`. */
export function repayToFromParty(partyId: string): Hex {
  if (typeof partyId !== 'string' || partyId.length === 0) throw new TypeError('repayTo: a Canton party id is a non-empty string');
  return toHex(keccak(utf8ToBytes(partyId)));
}

/** Whether `repayTo` is payable on an EVM source: zero top 12 bytes (`InvalidBytes32Address`) and not the zero address (`ZeroAddress`). */
export function isEvmRepayTo(repayTo: string): boolean {
  return /^0x0{24}[0-9a-fA-F]{40}$/.test(repayTo) && !/^0x0{64}$/.test(repayTo);
}

/** The address `settle` pays on an EVM source, `address(uint160(uint256(repayTo)))`; throws where the router reverts. */
export function evmAddressFromRepayTo(repayTo: string): Hex {
  hexBytes(repayTo, 'repayTo', 32);
  if (!isEvmRepayTo(repayTo)) throw new RangeError(`repayTo ${repayTo} is not a padded, non-zero EVM address`);
  return `0x${repayTo.slice(26).toLowerCase()}`;
}

/**
 * Whether `sig` has the shape a message key (an EOA) produces and the protocol
 * accepts: 65 bytes `r ‖ s ‖ v`, `v ∈ {27, 28}`, `0 < r < n`, low-s
 * `0 < s ≤ n/2`. Anything else is refused before recovery — an EIP-1271
 * smart-wallet signature among them: the message key is an EOA, verified by
 * ecrecover only. Passing this check says nothing about WHO signed: recover
 * the address and compare it with the registered key.
 */
export function isEoaSignature(sig: unknown): sig is Hex {
  if (typeof sig !== 'string' || !/^0x[0-9a-fA-F]{128}(1[bB]|1[cC])$/.test(sig)) return false;
  const r = BigInt(`0x${sig.slice(2, 66)}`);
  const s = BigInt(`0x${sig.slice(66, 130)}`);
  return r > 0n && r < SECP256K1_N && s > 0n && s <= SECP256K1_N / 2n;
}
