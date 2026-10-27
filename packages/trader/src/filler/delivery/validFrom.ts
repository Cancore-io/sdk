import type { DecString } from '@cancore/contracts';
import type { Clock } from '../runtime';
import { reasonOf } from './reverts';
import type { TransactionDriver } from './transactions';

export interface Waiting {
  status: 'waiting';
  detail: string;
}

/** `waiting` (with `wake` scheduled for `atMs`) while the process clock is short of `atMs`; undefined once it is not. */
export function awaitClock(clock: Clock, atMs: number, wake: () => void, detail: string): Waiting | undefined {
  if (clock.now() >= atMs) return undefined;
  clock.schedule(atMs - clock.now(), wake);
  return { status: 'waiting', detail };
}

export interface ValidFromWait {
  clock: Clock;
  driver: Pick<TransactionDriver, 'chainTime'>;
  /** `ticket.validFrom`, unix s. */
  validFrom: DecString;
  /** How soon the latest block is read again while it is short of `validFrom`, ms. */
  pollMs: number;
  /** Runs the delivery again. */
  wake: () => void;
  /** Told each time the clock is past `validFrom` but the latest block is not (or is unreadable), so a stalled destination is visible. */
  onChainLag?: (detail: string) => void;
}

/**
 * `waiting` (with `wake` scheduled) until both the process clock and the
 * latest block have reached `validFrom`; undefined once they have. The router
 * compares `validFrom` with `block.timestamp`, and the latest block lags the
 * clock by up to a block time (CAN-2986).
 */
export async function awaitValidFrom({ clock, driver, validFrom, pollMs, wake, onChainLag }: ValidFromWait): Promise<Waiting | undefined> {
  const early = awaitClock(clock, Number(validFrom) * 1000, wake, 'validFrom not reached');
  if (early) return early;
  let detail: string;
  try {
    const chainTime = await driver.chainTime();
    if (chainTime >= BigInt(validFrom)) return undefined;
    detail = `validFrom not reached on chain: latest block at ${chainTime}, validFrom ${validFrom}`;
  } catch (error) {
    detail = `latest block unreadable: ${reasonOf(error)}`;
  }
  onChainLag?.(detail);
  clock.schedule(pollMs, wake);
  return { status: 'waiting', detail };
}

/**
 * Allowance for the participant's clock running behind this process when the
 * ledger time of a Canton Fill is taken (CAN-3026): `DeliveryOrder_Fill`
 * compares `validFrom` with the ledger time, which the node cannot read (T-1).
 */
export const LEDGER_CLOCK_SLACK_MS = 1_000;
