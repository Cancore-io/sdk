import {
  base64UrlToBuffer,
  binaryStringToBytes,
  bufferToBase64Url,
  bytesToBinaryString,
  bytesToHex,
  hexToBytes,
  toUint8Array,
} from './bytes';

describe('bytes', () => {
  it('round-trips base64url including padding-edge lengths', () => {
    for (const len of [0, 1, 2, 3, 16, 32, 33]) {
      const bytes = new Uint8Array(len).map((_, i) => i % 256);
      const encoded = bufferToBase64Url(bytes);
      expect(encoded).not.toMatch(/[+/=]/);
      expect(base64UrlToBuffer(encoded)).toEqual(bytes);
    }
  });

  it('converts both ArrayBuffer and typed-array views to Uint8Array', () => {
    const ab = new Uint8Array([1, 2, 3, 4]).buffer;
    expect(toUint8Array(ab)).toEqual(new Uint8Array([1, 2, 3, 4]));

    const backing = new Uint8Array([9, 9, 5, 6, 7, 9, 9]);
    const view = new Uint8Array(backing.buffer, 2, 3); // offset view: [5, 6, 7]
    expect(toUint8Array(view)).toEqual(new Uint8Array([5, 6, 7]));
  });

  it('round-trips hex encoding', () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 255]);
    expect(bytesToHex(bytes)).toBe('00010f10ff');
    expect(hexToBytes('00010f10ff')).toEqual(bytes);
    expect(hexToBytes('0X00010F10FF')).toEqual(bytes);
  });

  it('rejects malformed hex input', () => {
    expect(() => hexToBytes('abc')).toThrow('Invalid hex string');
    expect(() => hexToBytes('zz')).toThrow('Invalid hex string');
  });

  it('round-trips the binary-string convention used by signMessage callers', () => {
    const bytes = new Uint8Array(256).map((_, i) => i); // full byte range, including >127
    const str = bytesToBinaryString(bytes);
    expect(str).toHaveLength(256);
    expect(binaryStringToBytes(str)).toEqual(bytes);
  });
});
