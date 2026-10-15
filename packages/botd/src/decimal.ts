/** Exact decimal math for every amount the daemon handles: 1e-10 fixed point, the ledger's Numeric 10. */
export const SCALE = 10n ** 10n;

/** A signed decimal string as exact 1e-10 units; throws on anything else, never rounds. */
export function dec(text: string): bigint {
  const m = /^(-?)(\d{1,20})(?:\.(\d{1,10}))?$/.exec(text);
  if (!m) throw new Error(`not a decimal: ${text}`);
  const v = BigInt(m[2]!) * SCALE + BigInt((m[3] ?? '').padEnd(10, '0'));
  return m[1] ? -v : v;
}

/** 1e-10 units back to the shortest decimal string. */
export function fmt(units: bigint): string {
  const sign = units < 0n ? '-' : '';
  const a = units < 0n ? -units : units;
  const frac = (a % SCALE).toString().padStart(10, '0').replace(/0+$/, '');
  return `${sign}${a / SCALE}${frac ? `.${frac}` : ''}`;
}

/** amount × price in 1e-10 units, rounded down or up to the scale. */
export function mul(amount: bigint, price: bigint, round: 'down' | 'up'): bigint {
  const p = amount * price;
  return p / SCALE + (round === 'up' && p % SCALE !== 0n ? 1n : 0n);
}
