import { exactNumericAmount } from './numeric-amount';

test.each([
  ['one negative ledger unit', '-0.0000000001'],
  ['a negative whole', '-1'],
  ['exponent notation', '1e5'],
  ['not a number', 'abc'],
  ['an empty string', ''],
  ['eleven decimals', '1.00000000001'],
  ['a decimal a double overflows to Infinity', '9'.repeat(309)],
])('BUG-1636 refuses %s as not a Numeric 10 amount', (_case, text) => {
  expect(() => exactNumericAmount(text)).toThrow(RangeError);
  expect(() => exactNumericAmount(text)).toThrow('Invalid Numeric 10 amount');
});

test.each([
  ['0', 0],
  ['0.0000000001', 1e-10],
  ['12345678.5', 12345678.5],
  ['1000000000000000000000', 1e21],
])('BUG-1636 passes %p on as the number it spells exactly', (text, value) => {
  expect(exactNumericAmount(text)).toBe(value);
});
