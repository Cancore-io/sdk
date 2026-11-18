import { AbiCoder } from 'ethers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeCantonOutputAsset, encodeCantonRecipient } from './cantonDestination';
import { abiEncodeStrings } from './encoding';
import { deliveryOrderCidHash } from './protocol/digests';
import { repayToFromParty } from './protocol/identity';
import { toHex } from './protocol/bytes';

const jcsCases = JSON.parse(readFileSync(join(__dirname, '..', 'spec', 'protocol', 'vectors', 'jcs.json'), 'utf8')) as { cases: { canonical: string }[] };

/** Every string value and key of the jcs.json golden cases: escapes, non-ASCII, non-BMP. */
const JCS_STRINGS: readonly string[] = [
  ...new Set(
    jcsCases.cases.flatMap(({ canonical }) => {
      const out: string[] = [];
      JSON.parse(canonical, (key: string, value: unknown) => {
        if (key !== '') out.push(key);
        if (typeof value === 'string') out.push(value);
        return value;
      });
      return out;
    }),
  ),
];

/** Party-id shaped and multi-byte strings, joined into one text and split again at every UTF-16 boundary. */
const TEXTS: readonly string[] = ['alice::1220abcd', 'a::b', '::', 'é€😀', 'דּö\u0080', ...JCS_STRINGS.slice(0, 6)];

const splits = (text: string): [string, string][] => {
  const out: [string, string][] = [];
  for (let i = 0; i <= text.length; i++) {
    const head = text.slice(0, i);
    const tail = text.slice(i);
    if (/\p{Cs}/u.test(head) || /\p{Cs}/u.test(tail)) continue;
    out.push([head, tail]);
  }
  return out;
};

describe('abiEncodeStrings: abi.encode(string, …, string) is injective', () => {
  test('the jcs.json strings are there to draw from', () => {
    expect(JCS_STRINGS.length).toBeGreaterThan(10);
    expect(JCS_STRINGS.some((s) => [...s].some((c) => c.codePointAt(0)! > 0x7f))).toBe(true);
  });

  test.each(TEXTS.map((t) => [t]))('moving the boundary between two fields of %j always changes the bytes', (text) => {
    const seen = new Map<string, string>();
    for (const [a, b] of splits(text)) {
      const encoded = toHex(abiEncodeStrings(['cancore:instrument:v1', a, b]));
      expect(seen.get(encoded)).toBeUndefined();
      seen.set(encoded, `${a}|${b}`);
    }
    expect(seen.size).toBe(splits(text).length);
  });

  test.each(JCS_STRINGS.map((s) => [s]))('equals ethers abi.encode for %j', (text) => {
    expect(toHex(abiEncodeStrings([text, 'x']))).toBe(AbiCoder.defaultAbiCoder().encode(['string', 'string'], [text, 'x']));
  });

  test('a lone surrogate is refused: TextEncoder would write it as U+FFFD, the bytes of another string', () => {
    expect(new TextEncoder().encode('\ud800')).toEqual(new TextEncoder().encode('�'));
    expect(() => abiEncodeStrings(['a', '\ud800'])).toThrow(/lone surrogate/);
    expect(() => abiEncodeStrings(['\udc00b', 'a'])).toThrow(/lone surrogate/);
    expect(() => abiEncodeStrings(['�', '😀'])).not.toThrow();
  });
});

describe('the Canton words of an order and a proof refuse a string with no UTF-8 form of its own', () => {
  test.each([
    ['recipient', () => encodeCantonRecipient('alice\ud800::1220ab')],
    ['outputAsset admin', () => encodeCantonOutputAsset({ admin: 'dso\udfff::1220ab', id: 'Amulet' })],
    ['outputAsset id', () => encodeCantonOutputAsset({ admin: 'dso::1220ab', id: 'Amu\ud83dlet' })],
    ['repayTo party', () => repayToFromParty('filler\ud800::1220ab')],
    ['deliveryOrderCid', () => deliveryOrderCidHash('00ab\udc00')],
  ])('%s', (_name, encode) => {
    expect(encode).toThrow(/lone surrogate/);
  });

  test('a well-formed pair of surrogates (one non-BMP character) still encodes', () => {
    expect(encodeCantonRecipient('alice😀::1220ab')).not.toBe(encodeCantonRecipient('alice�::1220ab'));
  });

  test('outputAsset changes when a character moves from the admin to the id', () => {
    const words = splits('dso::1220abAmulet').filter(([a, b]) => a && b).map(([admin, id]) => encodeCantonOutputAsset({ admin, id }));
    expect(new Set(words).size).toBe(words.length);
  });
});
