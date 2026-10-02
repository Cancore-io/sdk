/**
 * filler-gateway → filler frames: parsing and the checks every one of them
 * passes before the SDK acts on it (protocol §3.4, T-6).
 *
 * 1. One JSON object with a string `type`.
 * 2. `sentAt` is a millisecond timestamp and `sig` is present (§3.1).
 * 3. `sig` recovers, over `GatewayMessage{bodyHash}` in the protocol domain,
 *    to the pinned filler-gateway address from the config — never to an
 *    address a frame or `GET /v1/gateway` names.
 * 4. `fillerId` is this filler's id. It may be absent only on
 *    `auth.challenge` and on an `error` before login (§3.1, §10 D-C).
 *
 * A frame that fails any check is dropped and logged; nothing else happens.
 * Unknown fields and unknown types pass these checks untouched (V-2): what to
 * do with an unknown type is the dispatcher's call (it ignores it).
 */
import {
  ERROR_CODES,
  FILLER_PROTOCOL_DOMAIN,
  GATEWAY_MESSAGE_TYPES,
  gatewayBodyHash,
  hashTypedData,
  type Hex,
  type S2FBase,
} from '@cancore/contracts';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { GatewayError, UnsupportedVersionError } from '../errors';
import { recoverAddress } from '../signer';

/** A filler-gateway → filler frame as parsed: the base fields checked, every other field kept as received. */
export type GatewayFrame = S2FBase & Record<string, unknown>;

/** A filler-gateway → filler frame that passed every check, with the bytes it arrived as. */
export interface VerifiedFrame {
  readonly frame: GatewayFrame;
  /** The frame as received, UTF-8 — the evidence a dispute is decided on (protocol §3.4). */
  readonly raw: Uint8Array;
  /** `keccak256` of `raw`: the evidence journal key. A byte-identical redelivery has the same id. */
  readonly id: Hex;
}

/** Why a frame was dropped. */
export type FrameRejection =
  | 'not-json'
  | 'not-an-object'
  | 'no-type'
  | 'no-sentAt'
  | 'no-sig'
  | 'bad-sig'
  | 'wrong-signer'
  | 'no-fillerId'
  | 'other-fillerId';

export type FrameCheck = { ok: true; verified: VerifiedFrame } | { ok: false; reason: FrameRejection; type?: string };

export interface FrameExpectations {
  /** The pinned filler-gateway address (`FillerConfig.gatewaySigner`). */
  gatewaySigner: Hex;
  /** This filler's id. */
  fillerId: string;
}

/** Types that may arrive without `fillerId`: the addressee is not known yet. */
const UNADDRESSED_TYPES: ReadonlySet<string> = new Set(['auth.challenge', 'error']);

const encoder = new TextEncoder();
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const keccakHex = (bytes: Uint8Array): Hex => `0x${bytesToHex(keccak_256(bytes))}`;

/** The digest a filler-gateway `sig` is over: `GatewayMessage{keccak256(JCS(frame without sig))}`. */
export function gatewayMessageDigest(frame: Readonly<Record<string, unknown>>): Hex {
  return hashTypedData({
    domain: FILLER_PROTOCOL_DOMAIN,
    types: GATEWAY_MESSAGE_TYPES,
    primaryType: 'GatewayMessage',
    message: { bodyHash: gatewayBodyHash(frame) },
  });
}

/** Holds one parsed frame to every check. `raw` is the evidence kept with it. */
export function verifyGatewayObject(value: unknown, raw: Uint8Array, expect: FrameExpectations): FrameCheck {
  if (!isObject(value)) return { ok: false, reason: 'not-an-object' };
  const type = value.type;
  if (typeof type !== 'string' || type.length === 0) return { ok: false, reason: 'no-type' };
  if (typeof value.sentAt !== 'number' || !Number.isSafeInteger(value.sentAt)) return { ok: false, reason: 'no-sentAt', type };
  if (typeof value.sig !== 'string') return { ok: false, reason: 'no-sig', type };

  let signer: Hex;
  try {
    signer = recoverAddress(gatewayMessageDigest(value), value.sig as Hex);
  } catch {
    // Not 65 bytes / high-s / bad v, or a body JCS cannot canonicalise (a fraction, a lone surrogate).
    return { ok: false, reason: 'bad-sig', type };
  }
  if (signer !== expect.gatewaySigner.toLowerCase()) return { ok: false, reason: 'wrong-signer', type };

  if (value.fillerId === undefined) {
    if (!UNADDRESSED_TYPES.has(type)) return { ok: false, reason: 'no-fillerId', type };
  } else if (value.fillerId !== expect.fillerId) {
    return { ok: false, reason: 'other-fillerId', type };
  }
  return { ok: true, verified: { frame: value as GatewayFrame, raw, id: keccakHex(raw) } };
}

/** Parses one WebSocket text frame and holds it to every check. */
export function verifyGatewayText(text: string, expect: FrameExpectations): FrameCheck {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not-json' };
  }
  return verifyGatewayObject(value, encoder.encode(text), expect);
}

/**
 * The bytes a frame that came nested in a larger REST body (a list item) is
 * journalled as: its JSON text. Its `sig` is over the JCS of its fields, so
 * the evidence verifies whatever the serialisation.
 */
export const frameBytes = (frame: unknown): Uint8Array => encoder.encode(JSON.stringify(frame));

export const utf8 = (text: string): Uint8Array => encoder.encode(text);

const KNOWN_CODES: ReadonlySet<string> = new Set(ERROR_CODES);

/** The typed error an `error` frame or REST error body carries; an unknown code stays generic (V-2). */
export function gatewayErrorOf(body: Readonly<Record<string, unknown>>, httpStatus?: number): GatewayError {
  const code = typeof body.code === 'string' && body.code.length > 0 ? body.code : 'UNKNOWN';
  const message = typeof body.message === 'string' ? body.message : '';
  const re = typeof body.re === 'string' ? body.re : undefined;
  if (code === 'UNSUPPORTED_VERSION') return new UnsupportedVersionError(code, true, message, re, httpStatus);
  return new GatewayError(code, KNOWN_CODES.has(code), message, re, httpStatus);
}
