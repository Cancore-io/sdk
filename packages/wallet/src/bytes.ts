/**
 * Byte/encoding helpers for the passkey wallet module.
 *
 * WebCrypto's `BufferSource`-typed APIs require an ArrayBuffer-backed view.
 * TS 5.7+ made typed arrays generic over their backing buffer and defaults a
 * bare `Uint8Array` annotation to `Uint8Array<ArrayBufferLike>` (which also
 * covers `SharedArrayBuffer`), so it is no longer assignable to
 * `BufferSource`. Every helper here is pinned to `Bytes` so callers can pass
 * results straight into `crypto.subtle`/WebAuthn without extra casts.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

const HEX_RE = /^[0-9a-fA-F]+$/;

export function hexToBytes(hex: string): Bytes {
  const clean = hex.trim().replace(/^0x/i, '');
  if (clean.length % 2 !== 0 || (clean.length > 0 && !HEX_RE.test(clean))) {
    throw new Error('Invalid hex string');
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** base64url encode (no padding), used for WebAuthn credential ids. */
export function bufferToBase64Url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBuffer(b64url: string): Bytes {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const str = atob(padded);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return bytes;
}

/** WebAuthn extension outputs are typed as `BufferSource` (ArrayBuffer | ArrayBufferView). */
export function toUint8Array(source: BufferSource): Bytes {
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
}

/**
 * Binary-string <-> bytes conversion: each char code is exactly one raw byte
 * (latin1), matching the convention every existing `signMessage` caller
 * relies on (e.g. the local `hexToBytes` in `useExternalPartySetup.ts`, or
 * this same pattern in `bufferToBase64Url` above) — this is NOT UTF-8 text
 * decoding, which would corrupt bytes outside the ASCII range.
 */
export function bytesToBinaryString(bytes: Uint8Array): string {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return str;
}

export function binaryStringToBytes(str: string): Bytes {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
  return bytes;
}
